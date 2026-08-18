// Native A1 boundary. This source is intentionally separate from the Bun
// daemon: private keys never cross the Secure Enclave/Keychain boundary.
import Foundation
import LocalAuthentication
import Security
import Darwin
import CryptoKit

private let maxFrame = 4096
private let maxBody = 2048
private let protocolVersion = "agent-mail-macos-operator-presence-v1"

enum BrokerFailure: Error { case malformed, unauthorized, unavailable }

private typealias BrokerConfiguration = (authorityInstanceId: String, revision: Int)
private let operatorCredentialLifetime: TimeInterval = 365 * 24 * 60 * 60
private let operatorPrincipal = "principal:local-operator"
private let operatorProfile = "operator-interactive"
private let operatorAlgorithm = "ES256"

private func assertPrivateRoot(_ path: String) throws {
    guard path.hasPrefix("/"), !path.contains("\0"), path == URL(fileURLWithPath: path).standardizedFileURL.path else {
        throw BrokerFailure.malformed
    }
    var info = stat()
    guard stat(path, &info) == 0, (info.st_mode & S_IFMT) == S_IFDIR,
          (info.st_mode & 0o777) == 0o700, info.st_uid == getuid(), getuid() == geteuid() else {
        throw BrokerFailure.unauthorized
    }
}

private func loadConfiguration(_ privateRoot: String) throws -> BrokerConfiguration {
    let object = try loadConfigurationObject(privateRoot)
    guard
          let instance = object["authorityInstanceId"] as? String,
          let revision = object["configurationRevision"] as? Int,
          instance.range(of: "^instance:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", options: .regularExpression) != nil,
          revision > 0 else {
        throw BrokerFailure.malformed
    }
    return (instance, revision)
}

private func loadConfigurationObject(_ privateRoot: String) throws -> [String: Any] {
    let path = "\(privateRoot)/config/operator-credentials.v1.json"
    var info = stat()
    guard lstat(path, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG,
          (info.st_mode & 0o777) == 0o600, info.st_uid == getuid() else {
        throw BrokerFailure.unauthorized
    }
    let data = try Data(contentsOf: URL(fileURLWithPath: path), options: [.uncached])
    guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        throw BrokerFailure.malformed
    }
    guard Set(object.keys) == Set(["schemaVersion", "authorityInstanceId", "configurationRevision", "updatedAt", "credentials"]) else {
        throw BrokerFailure.malformed
    }
    return object
}

private func loadConfigurationObjectIfPresent(_ privateRoot: String) throws -> [String: Any]? {
    let path = "\(privateRoot)/config/operator-credentials.v1.json"
    var info = stat()
    if lstat(path, &info) != 0 {
        guard errno == ENOENT else { throw BrokerFailure.unauthorized }
        return nil
    }
    return try loadConfigurationObject(privateRoot)
}

private func freshContext() throws -> LAContext {
    let context = LAContext()
    context.touchIDAuthenticationAllowableReuseDuration = 0
    var error: NSError?
    guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else { throw BrokerFailure.unavailable }
    return context
}

private func freshOwnerPresence(_ localizedReason: String) throws -> LAContext {
    let context = try freshContext()
    let wait = DispatchSemaphore(value: 0)
    var accepted = false
    context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: localizedReason) { success, _ in
        accepted = success
        wait.signal()
    }
    wait.wait()
    guard accepted else { throw BrokerFailure.unauthorized }
    return context
}

private func signWithFreshPresence(_ key: SecKey, _ message: Data, _ localizedReason: String) throws -> Data {
    let context = try freshOwnerPresence(localizedReason)
    // A successful policy evaluation is not itself an authorization for an
    // unrelated key operation. Re-resolve the non-exportable key while the
    // fresh, zero-reuse context is attached to the Keychain query; the SecKey
    // returned by that query is the only value admitted to signing.
    let boundKey = try keyWithAuthenticationContext(key, context)
    let algorithm = SecKeyAlgorithm.ecdsaSignatureMessageX962SHA256
    guard SecKeyIsAlgorithmSupported(boundKey, .sign, algorithm) else { throw BrokerFailure.unavailable }
    var error: Unmanaged<CFError>?
    guard let signature = SecKeyCreateSignature(boundKey, algorithm, message as CFData, &error) as Data? else {
        throw BrokerFailure.unauthorized
    }
    guard let p1363 = derToLowSP1363(signature) else { throw BrokerFailure.unavailable }
    return p1363
}

private func keyWithAuthenticationContext(_ key: SecKey, _ context: LAContext) throws -> SecKey {
    guard
        let attributes = SecKeyCopyAttributes(key) as? [CFString: Any],
        let tag = attributes[kSecAttrApplicationTag] as? Data
    else { throw BrokerFailure.unavailable }
    let query: [CFString: Any] = [
        kSecClass: kSecClassKey,
        kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom,
        kSecAttrApplicationTag: tag,
        kSecUseAuthenticationContext: context,
        kSecReturnRef: true,
        kSecMatchLimit: kSecMatchLimitOne,
    ]
    var result: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
          let result else { throw BrokerFailure.unauthorized }
    guard CFGetTypeID(result) == SecKeyGetTypeID() else { throw BrokerFailure.unauthorized }
    return unsafeBitCast(result, to: SecKey.self)
}

private func derToLowSP1363(_ der: Data) -> Data? {
    let bytes = Array(der)
    guard bytes.count >= 8, bytes[0] == 0x30 else { return nil }
    var offset = 2
    guard bytes[1] == bytes.count - 2, bytes[offset] == 0x02 else { return nil }
    let rLength = Int(bytes[offset + 1]); offset += 2
    guard rLength > 0, offset + rLength + 2 <= bytes.count, bytes[offset + rLength] == 0x02 else { return nil }
    let r = bytes[offset..<(offset + rLength)]; offset += rLength
    let sLength = Int(bytes[offset + 1]); offset += 2
    guard sLength > 0, offset + sLength == bytes.count else { return nil }
    let s = Array(bytes[offset..<(offset + sLength)])
    guard let normalizedR = normalizeScalar(Array(r)), var normalizedS = normalizeScalar(s) else { return nil }
    let halfOrder = hexBytes("7fffffff800000007fffffffffffffffde737d56d38bcf4279dce5617e3192a8")
    let order = hexBytes("ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551")
    guard halfOrder.count == 32, order.count == 32 else { return nil }
    guard normalizedR.contains(where: { $0 != 0 }), normalizedS.contains(where: { $0 != 0 }), compareBytes(normalizedR, order) < 0, compareBytes(normalizedS, order) < 0 else { return nil }
    if compareBytes(normalizedS, halfOrder) > 0 { normalizedS = subtractBytes(order, normalizedS) }
    return Data(normalizedR + normalizedS)
}

private func normalizeScalar(_ value: [UInt8]) -> [UInt8]? {
    var result = value
    while result.count > 32 && result.first == 0 { result.removeFirst() }
    guard result.count <= 32 else { return nil }
    return Array(repeating: UInt8(0), count: 32 - result.count) + result
}

private func hexBytes(_ value: String) -> [UInt8] {
    stride(from: 0, to: value.count, by: 2).compactMap { index in
        let start = value.index(value.startIndex, offsetBy: index)
        let end = value.index(start, offsetBy: 2)
        return UInt8(value[start..<end], radix: 16)
    }
}

private func compareBytes(_ left: [UInt8], _ right: [UInt8]) -> Int {
    for (a, b) in zip(left, right) where a != b { return a < b ? -1 : 1 }
    return 0
}

private func subtractBytes(_ left: [UInt8], _ right: [UInt8]) -> [UInt8] {
    var result = Array(repeating: UInt8(0), count: left.count)
    var borrow = 0
    for index in stride(from: left.count - 1, through: 0, by: -1) {
        let value = Int(left[index]) - Int(right[index]) - borrow
        result[index] = UInt8((value + 256) & 0xff)
        borrow = value < 0 ? 1 : 0
    }
    return result
}

private func secureEnclaveKey(tag: Data) throws -> SecKey {
    guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, [.userPresence, .privateKeyUsage], nil) else {
        throw BrokerFailure.unavailable
    }
    let attributes: [CFString: Any] = [
        kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom,
        kSecAttrKeySizeInBits: 256,
        kSecAttrTokenID: kSecAttrTokenIDSecureEnclave,
        kSecPrivateKeyAttrs: [kSecAttrIsPermanent: true, kSecAttrApplicationTag: tag, kSecAttrAccessControl: access],
    ]
    var error: Unmanaged<CFError>?
    guard let key = SecKeyCreateRandomKey(attributes as CFDictionary, &error) else { throw BrokerFailure.unavailable }
    return key
}

private func ownerOnlySocket(_ fd: Int32) throws {
    guard getuid() == geteuid() else { throw BrokerFailure.unauthorized }
    guard fchmod(fd, mode_t(0o600)) == 0 else { throw BrokerFailure.unauthorized }
}

private func ownerPeer(_ fd: Int32) -> Bool {
    var uid: uid_t = 0
    var gid: gid_t = 0
    return getpeereid(fd, &uid, &gid) == 0 && uid == getuid()
}

private func readOneFrame(_ fd: Int32) throws -> Data {
    var bytes = Data()
    var byte: UInt8 = 0
    while bytes.count <= maxFrame {
        let count = read(fd, &byte, 1)
        if count != 1 { throw BrokerFailure.malformed }
        bytes.append(byte)
        if byte == 0x0a { break }
    }
    guard bytes.last == 0x0a, bytes.count <= maxFrame, bytes.dropLast().firstIndex(of: 0x0a) == nil else { throw BrokerFailure.malformed }
    return bytes.dropLast()
}

private func writeResponse(_ fd: Int32, _ value: Any) throws {
    let bytes = try canonicalJSON(value) + Data([0x0a])
    try writeBytes(fd, bytes)
}

private func writeBytes(_ fd: Int32, _ bytes: Data) throws {
    guard bytes.count <= maxFrame else { throw BrokerFailure.malformed }
    try bytes.withUnsafeBytes { raw in
        guard let base = raw.baseAddress else { throw BrokerFailure.unavailable }
        var written = 0
        while written < bytes.count {
            let count = write(fd, base.advanced(by: written), bytes.count - written)
            guard count > 0 else { throw BrokerFailure.unavailable }
            written += count
        }
    }
    shutdown(fd, SHUT_WR)
}

/**
 * Provisioning never publishes authority files itself.  It submits only the
 * signed public ceremony proof to the owner-only daemon adapter; that adapter
 * reacquires the shared/exclusive authority lock, revalidates the current
 * revision/instance, publishes the file, and closes durable authority before
 * releasing admission.
 */
private func submitMutationRequest(_ privateRoot: String, _ request: [String: Any]) throws {
    let socketPath = "\(privateRoot)/runtime/operator-authority-mutation.sock"
    var info = stat()
    guard lstat(socketPath, &info) == 0,
          (info.st_mode & S_IFMT) == S_IFSOCK,
          (info.st_mode & 0o777) == 0o600,
          info.st_uid == getuid() else { throw BrokerFailure.unavailable }
    let client = socket(AF_UNIX, SOCK_STREAM, 0)
    guard client >= 0 else { throw BrokerFailure.unavailable }
    defer { close(client) }
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    socketPath.withCString { source in
        withUnsafeMutableBytes(of: &address.sun_path) { target in
            target.copyMemory(from: UnsafeRawBufferPointer(start: source, count: min(socketPath.utf8.count + 1, target.count)))
        }
    }
    let addressLength = socklen_t(MemoryLayout<sockaddr_un>.size)
    let connected = withUnsafePointer(to: &address) { pointer in
        pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(client, $0, addressLength) }
    }
    guard connected == 0 else { throw BrokerFailure.unavailable }
    try writeBytes(client, try canonicalJSON(request) + Data([0x0a]))
    let response = try readOneFrame(client)
    guard let object = try JSONSerialization.jsonObject(with: response) as? [String: Any],
          object["version"] as? String == "agent-mail-authority-mutation-v1",
          object["ok"] as? Bool == true else { throw BrokerFailure.unauthorized }
}

private func submitMutation(_ privateRoot: String, _ proof: [String: Any]) throws {
    try submitMutationRequest(privateRoot, [
        "version": "agent-mail-authority-mutation-v1",
        "command": "apply",
        "proof": proof,
    ])
}

private func issueChallenge(_ privateRoot: String, _ request: [String: Any]) throws -> [String: Any] {
    let socketPath = "\(privateRoot)/runtime/operator-presence.sock"
    var info = stat()
    guard lstat(socketPath, &info) == 0,
          (info.st_mode & S_IFMT) == S_IFSOCK,
          (info.st_mode & 0o777) == 0o600,
          info.st_uid == getuid() else { throw BrokerFailure.unavailable }
    let client = socket(AF_UNIX, SOCK_STREAM, 0)
    guard client >= 0 else { throw BrokerFailure.unavailable }
    defer { close(client) }
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    socketPath.withCString { source in
        withUnsafeMutableBytes(of: &address.sun_path) { target in
            target.copyMemory(from: UnsafeRawBufferPointer(start: source, count: min(socketPath.utf8.count + 1, target.count)))
        }
    }
    let connected = withUnsafePointer(to: &address) { pointer in
        pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            connect(client, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
        }
    }
    guard connected == 0 else { throw BrokerFailure.unavailable }
    try writeBytes(client, try canonicalJSON(request) + Data([0x0a]))
    let response = try readOneFrame(client)
    guard let object = try JSONSerialization.jsonObject(with: response) as? [String: Any],
          object["version"] as? String == protocolVersion,
          object["error"] == nil else { throw BrokerFailure.unauthorized }
    return object
}

private func jsonString(_ value: String) -> String {
    guard let data = try? JSONSerialization.data(withJSONObject: [value], options: []) else {
        return "\"\""
    }
    let array = String(decoding: data, as: UTF8.self)
    let scalar = String(array.dropFirst().dropLast())
    return scalar.replacingOccurrences(of: "\\/", with: "/")
}

private func writeErrorResponse(_ fd: Int32) throws {
    let text = "{\"version\":\(jsonString(protocolVersion)),\"error\":{\"code\":\"action.operator_assertion_invalid\",\"message\":\"operator presence assertion is invalid\"}}"
    try writeBytes(fd, Data((text + "\n").utf8))
}

private func canonicalBase64url(_ value: String) -> Data? {
    guard !value.contains("=") else { return nil }
    let padded = value + String(repeating: "=", count: (4 - value.count % 4) % 4)
    guard let data = Data(base64Encoded: padded), data.base64EncodedString()
        .replacingOccurrences(of: "+", with: "-")
        .replacingOccurrences(of: "/", with: "_")
        .trimmingCharacters(in: CharacterSet(charactersIn: "=")) == value else { return nil }
    return data
}

private func base64url(_ data: Data) -> String {
    data.base64EncodedString()
        .replacingOccurrences(of: "+", with: "-")
        .replacingOccurrences(of: "/", with: "_")
        .trimmingCharacters(in: CharacterSet(charactersIn: "="))
}

private func publicSpki(_ key: SecKey) throws -> Data {
    guard let raw = SecKeyCopyExternalRepresentation(key, nil) as Data?, raw.count == 65, raw.first == 0x04 else {
        throw BrokerFailure.unavailable
    }
    return Data(hexBytes("3059301306072a8648ce3d020106082a8648ce3d030107034200")) + raw
}

private func secureKeyForCredential(_ credential: [String: Any]) throws -> SecKey {
    guard let expected = credential["publicKeySpkiSha256"] as? String else { throw BrokerFailure.malformed }
    let query: [CFString: Any] = [
        kSecClass: kSecClassKey,
        kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom,
        kSecReturnRef: true,
        kSecMatchLimit: kSecMatchLimitAll,
    ]
    var result: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess else {
        throw BrokerFailure.unavailable
    }
    guard let candidates = result as? [SecKey] else { throw BrokerFailure.unavailable }
    for candidate in candidates {
        guard let publicKey = SecKeyCopyPublicKey(candidate), let spki = try? publicSpki(publicKey) else { continue }
        let digest = SHA256.hash(data: spki).map { String(format: "%02x", $0) }.joined()
        if digest == expected { return candidate }
    }
    throw BrokerFailure.unavailable
}

private func randomBytes(_ count: Int) throws -> Data {
    var bytes = Data(count: count)
    guard bytes.withUnsafeMutableBytes({ SecRandomCopyBytes(kSecRandomDefault, count, $0.baseAddress!) == errSecSuccess }) else {
        throw BrokerFailure.unavailable
    }
    return bytes
}

private func randomBase64url(_ count: Int) throws -> String {
    base64url(try randomBytes(count))
}

private func verifyLowSignature(_ key: SecKey, _ message: Data, _ signature: Data) throws {
    guard let der = p1363ToDer(signature), let publicKey = SecKeyCopyPublicKey(key) else {
        throw BrokerFailure.unavailable
    }
    guard SecKeyVerifySignature(publicKey, .ecdsaSignatureMessageX962SHA256, message as CFData, der as CFData, nil) else {
        throw BrokerFailure.unauthorized
    }
}

private func p1363ToDer(_ signature: Data) -> Data? {
    guard signature.count == 64 else { return nil }
    func scalar(_ bytes: [UInt8]) -> [UInt8] {
        var value = Array(bytes.drop { $0 == 0 })
        if value.isEmpty { value = [0] }
        if (value[0] & 0x80) != 0 { value.insert(0, at: 0) }
        return value
    }
    let r = scalar(Array(signature.prefix(32))); let s = scalar(Array(signature.suffix(32)))
    let body = [0x02, UInt8(r.count)] + r + [0x02, UInt8(s.count)] + s
    return Data([0x30, UInt8(body.count)] + body)
}

private func canonicalJSON(_ value: Any) throws -> Data {
    let data = try JSONSerialization.data(withJSONObject: value, options: [])
    // Foundation may escape solidus characters while JavaScript JSON.stringify
    // does not. The commitment is cross-runtime bytes, so normalize that one
    // representation before hashing or storing it.
    return Data(String(decoding: data, as: UTF8.self).replacingOccurrences(of: "\\/", with: "/").utf8)
}

private func credentialList(_ configuration: [String: Any]) throws -> [[String: Any]] {
    guard configuration["schemaVersion"] as? Int == 1,
          let instance = configuration["authorityInstanceId"] as? String,
          instance.range(of: "^instance:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", options: .regularExpression) != nil,
          let revision = configuration["configurationRevision"] as? Int, revision > 0,
          let records = configuration["credentials"] as? [[String: Any]], records.count <= 2 else {
        throw BrokerFailure.malformed
    }
    for record in records {
        guard Set(record.keys) == Set(["credentialId", "principalId", "profile", "algorithm", "publicKeySpkiBase64url", "publicKeySpkiSha256", "status", "enrolledAt", "expiresAt", "revokedAt", "replacedByCredentialId"]),
              record["credentialId"] as? String != nil,
              record["principalId"] as? String == operatorPrincipal,
              record["profile"] as? String == operatorProfile,
              record["algorithm"] as? String == operatorAlgorithm,
              record["publicKeySpkiBase64url"] as? String != nil,
              record["publicKeySpkiSha256"] as? String != nil,
              record["status"] as? String == "active" || record["status"] as? String == "revoked" else {
            throw BrokerFailure.malformed
        }
    }
    return records
}

private func activeCredential(_ records: [[String: Any]]) -> [String: Any]? {
    records.first { $0["status"] as? String == "active" }
}

private func enrollmentMaterial(
    authorityInstanceId: String,
    reason: String,
) throws -> (credential: [String: Any], key: SecKey, proof: [String: Any]) {
    let enrollmentId = "enrollment:\(UUID().uuidString.lowercased())"
    let key = try secureEnclaveKey(tag: Data("dev.johnlombardo.agent-mail.operator.v1:\(enrollmentId)".utf8))
    guard let publicKey = SecKeyCopyPublicKey(key) else { throw BrokerFailure.unavailable }
    let publicBytes = try publicSpki(publicKey)
    let publicKeyBase64url = base64url(publicBytes)
    let credentialId = "credential:operator:\(SHA256.hash(data: publicBytes).map { String(format: "%02x", $0) }.joined())"
    // The lifetime is derived from the exact instant represented by the
    // published enrolledAt value.  Computing expiry independently before the
    // biometric ceremony produces a subtly-short credential that the daemon
    // correctly rejects.
    let enrolledDate = Date()
    let enrolledAt = canonicalInstant(enrolledDate)
    let credentialExpiresAt = Date(timeInterval: operatorCredentialLifetime, since: enrolledDate)
    let nonce = try randomBase64url(32)
    let commitment = try canonicalJSON([
        "agent-mail-operator-enrollment-v1", authorityInstanceId, enrollmentId,
        operatorPrincipal, credentialId, operatorProfile, operatorAlgorithm,
        publicKeyBase64url, enrolledAt, nonce,
    ])
    let signature = try signWithFreshPresence(key, commitment, reason)
    try verifyLowSignature(key, commitment, signature)
    let credential: [String: Any] = [
        "credentialId": credentialId,
        "principalId": operatorPrincipal,
        "profile": operatorProfile,
        "algorithm": operatorAlgorithm,
        "publicKeySpkiBase64url": publicKeyBase64url,
        "publicKeySpkiSha256": SHA256.hash(data: publicBytes).map { String(format: "%02x", $0) }.joined(),
        "status": "active",
        "enrolledAt": enrolledAt,
        "expiresAt": canonicalInstant(credentialExpiresAt),
        "revokedAt": NSNull(),
        "replacedByCredentialId": NSNull(),
    ]
    let proof: [String: Any] = [
        "credentialId": credentialId,
        "publicKeySpkiBase64url": publicKeyBase64url,
        "enrollmentCommitment": String(decoding: commitment, as: UTF8.self),
        "signatureP1363Base64url": base64url(signature),
    ]
    return (credential, key, proof)
}

private func nextConfiguration(
    _ configuration: [String: Any],
    authorityInstanceId: String? = nil,
    credentials: [[String: Any]],
    updatedAt: String,
) throws -> [String: Any] {
    guard let revision = configuration["configurationRevision"] as? Int, revision > 0 else {
        throw BrokerFailure.malformed
    }
    let instance = authorityInstanceId ?? (configuration["authorityInstanceId"] as? String ?? "")
    guard instance.range(of: "^instance:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", options: .regularExpression) != nil,
          credentials.count > 0, credentials.count <= 2 else { throw BrokerFailure.malformed }
    return [
        "schemaVersion": 1,
        "authorityInstanceId": instance,
        "configurationRevision": revision + 1,
        "updatedAt": updatedAt,
        "credentials": credentials,
    ]
}

private func administrativeSignature(
    _ key: SecKey,
    commitment: Data,
    reason: String,
) throws -> String {
    let signature = try signWithFreshPresence(key, commitment, reason)
    try verifyLowSignature(key, commitment, signature)
    return base64url(signature)
}

private let sealKeyIdPattern = "^approval-seal-key:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"

private func loadSealKeyringObject(_ privateRoot: String) throws -> [String: Any] {
    let path = "\(privateRoot)/secrets/action-approval-seal-keyring.v1.json"
    var info = stat()
    guard lstat(path, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG,
          (info.st_mode & 0o777) == 0o600, info.st_uid == getuid() else {
        throw BrokerFailure.unavailable
    }
    let data = try Data(contentsOf: URL(fileURLWithPath: path), options: [.uncached])
    guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
          object.keys.count == 5,
          object["schemaVersion"] as? Int == 1,
          let revision = object["keyringRevision"] as? Int, revision > 0,
          object["updatedAt"] as? String != nil,
          let active = object["activeKeyId"] as? String,
          active.range(of: sealKeyIdPattern, options: .regularExpression) != nil,
          let keys = object["keys"] as? [[String: Any]], !keys.isEmpty else {
        throw BrokerFailure.malformed
    }
    var activeCount = 0
    var ids = Set<String>()
    var values = Set<String>()
    for key in keys {
        guard key.keys.count == 5,
              let keyId = key["keyId"] as? String,
              keyId.range(of: sealKeyIdPattern, options: .regularExpression) != nil,
              ids.insert(keyId).inserted,
              let status = key["status"] as? String, status == "active" || status == "verify-only",
              let value = key["keyBase64url"] as? String,
              let bytes = canonicalBase64url(value), bytes.count == 32,
              values.insert(value).inserted,
              key["createdAt"] as? String != nil,
              key["statusChangedAt"] as? String != nil else { throw BrokerFailure.malformed }
        if status == "active" { activeCount += 1 }
    }
    guard activeCount <= 1, active == (keys.first { $0["status"] as? String == "active" }?["keyId"] as? String) else {
        throw BrokerFailure.malformed
    }
    let sorted = keys.sorted { ($0["keyId"] as? String ?? "") < ($1["keyId"] as? String ?? "") }
    let sortedIds = sorted.compactMap { $0["keyId"] as? String }
    let originalIds = keys.compactMap { $0["keyId"] as? String }
    guard sortedIds.count == keys.count, sortedIds == originalIds else {
        throw BrokerFailure.malformed
    }
    return object
}

private func runSealKeyCommand(_ command: String, _ privateRoot: String, _ keyId: String?) throws {
    let current = try loadSealKeyringObject(privateRoot)
    let configuration = try loadConfigurationObject(privateRoot)
    let records = try credentialList(configuration)
    guard let credential = activeCredential(records),
          let credentialId = credential["credentialId"] as? String,
          let authorityInstanceId = configuration["authorityInstanceId"] as? String else {
        throw BrokerFailure.unauthorized
    }
    guard let revision = current["keyringRevision"] as? Int,
          let oldKeys = current["keys"] as? [[String: Any]],
          let activeId = current["activeKeyId"] as? String else { throw BrokerFailure.malformed }
    let operation = command == "rotate" ? "seal-key-rotate" : "seal-key-remove"
    let targetId: String
    if command == "rotate" {
        targetId = activeId
    } else {
        guard let keyId, keyId.range(of: sealKeyIdPattern, options: .regularExpression) != nil,
              let target = oldKeys.first(where: { $0["keyId"] as? String == keyId }),
              target["status"] as? String == "verify-only" else { throw BrokerFailure.unauthorized }
        targetId = keyId
    }
    let bodyObject: [String: Any] = command == "rotate"
        ? ["expectedKeyringRevision": revision, "expectedActiveKeyId": targetId]
        : ["expectedKeyringRevision": revision, "keyId": targetId]
    let body = try canonicalJSON(bodyObject)
    let challenge = try issueChallenge(privateRoot, [
        "version": protocolVersion,
        "command": "issue",
        "credentialId": credentialId,
        "operation": operation,
        "requestMethod": "ADMIN",
        "requestPath": command == "rotate" ? "/internal/action-authority/seal-keyring/rotate" : "/internal/action-authority/seal-keyring/remove",
        "requestBodyBase64url": base64url(body),
    ])
    guard let challengeId = challenge["challengeId"] as? String,
          let commitment = challenge["challengeCommitment"] as? String,
          let display = challenge["operatorDisplayCode"] as? String else { throw BrokerFailure.unavailable }
    guard display == displayCode(operation, body, authorityInstanceId) else { throw BrokerFailure.unauthorized }
    let reasonVerb = command == "rotate" ? "ROTATE" : "REMOVE"
    let prompt = "Agent Mail \(reasonVerb) approval seal key \(targetId) revision \(revision) code \(display)\nProceed? [y/yes] "
    FileHandle.standardOutput.write(Data(prompt.utf8))
    guard let answer = readLine()?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
          answer == "y" || answer == "yes" else { throw BrokerFailure.unauthorized }
    let authorityConfiguration = try loadConfiguration(privateRoot)
    let assertion = try signChallenge([
        "version": protocolVersion,
        "command": "sign",
        "challengeId": challengeId,
        "credentialId": credentialId,
        "challengeCommitment": commitment,
        "operation": operation,
        "requestMethod": "ADMIN",
        "requestPath": command == "rotate" ? "/internal/action-authority/seal-keyring/rotate" : "/internal/action-authority/seal-keyring/remove",
        "requestBodyBase64url": base64url(body),
    ], privateRoot: privateRoot, configuration: authorityConfiguration)
    try submitMutationRequest(privateRoot, [
        "version": "agent-mail-action-authority-admin-v1",
        "requestBodyBase64url": base64url(body),
        "assertion": assertion,
    ])
}

private func displayCode(_ operation: String, _ body: Data, _ authorityInstanceId: String) -> String {
    let value = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
    let fields: [Any]
    if operation == "open-session" {
        fields = ["agent-mail-presence-display-v1", "open-session", authorityInstanceId, "mail:action.create", "mail:action.inspect"]
    } else if operation == "seal-key-rotate" || operation == "seal-key-remove" {
        guard let value,
              let revision = value["expectedKeyringRevision"] as? Int,
              let target = (operation == "seal-key-rotate" ? value["expectedActiveKeyId"] : value["keyId"]) as? String else {
            return ""
        }
        fields = ["agent-mail-presence-display-v1", operation, authorityInstanceId, revision, target]
    } else {
        fields = [
            "agent-mail-presence-display-v1", operation,
            value?["planId"] as? String ?? "",
            value?["planVersion"] as? Int ?? 0,
            value?["previewDigest"] as? String ?? "",
        ]
    }
    let bytes = (try? canonicalJSON(fields)) ?? body
    let bodyDigest = SHA256.hash(data: bytes)
    let hex = bodyDigest.map { String(format: "%02x", $0) }.joined()
    let prefix = String(hex.prefix(20))
    return stride(from: 0, to: prefix.count, by: 4).map { index in
        let start = prefix.index(prefix.startIndex, offsetBy: index)
        let end = prefix.index(start, offsetBy: min(4, prefix.distance(from: start, to: prefix.endIndex)))
        return String(prefix[start..<end])
    }.joined(separator: "-")
}

private func strictActionBody(_ operation: String, _ body: Data) throws -> [String: Any] {
    guard let value = try JSONSerialization.jsonObject(with: body) as? [String: Any] else {
        throw BrokerFailure.malformed
    }
    if operation == "seal-key-rotate" || operation == "seal-key-remove" {
        let expected = operation == "seal-key-rotate"
            ? ["expectedKeyringRevision", "expectedActiveKeyId"]
            : ["expectedKeyringRevision", "keyId"]
        guard Set(value.keys) == Set(expected),
              let revision = value["expectedKeyringRevision"] as? Int, revision > 0,
              let target = value[expected[1]] as? String,
              target.range(of: sealKeyIdPattern, options: .regularExpression) != nil else {
            throw BrokerFailure.malformed
        }
        return value
    }
    let expected = operation == "approve"
        ? ["planId", "planVersion", "previewDigest"]
        : ["planId", "approvalId", "planVersion", "previewDigest"]
    guard Set(value.keys) == Set(expected),
          let planId = value["planId"] as? String, planId.hasPrefix("plan:"),
          let planVersion = value["planVersion"] as? Int, planVersion > 0,
          let previewDigest = value["previewDigest"] as? String,
          previewDigest.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else {
        throw BrokerFailure.malformed
    }
    if operation == "cancel-approval" {
        guard let approvalId = value["approvalId"] as? String, approvalId.hasPrefix("approval:") else {
            throw BrokerFailure.malformed
        }
    }
    return value
}

private func strictSessionBody(_ body: Data) throws {
    guard let value = try JSONSerialization.jsonObject(with: body) as? [String: Any],
          Set(value.keys) == Set(["requestedScopes"]),
          let scopes = value["requestedScopes"] as? [String],
          scopes == ["mail:action.create", "mail:action.inspect"] else {
        throw BrokerFailure.malformed
    }
}

private func exactChallengeLifetime(_ issuedAt: String, _ expiresAt: String) -> Bool {
    let formatter = ISO8601DateFormatter()
    guard let issued = formatter.date(from: issuedAt), let expires = formatter.date(from: expiresAt) else {
        return false
    }
    return expires.timeIntervalSince(issued) == 60
}

private func hasCanonicalFieldOrder(_ frame: Data, _ fields: [String]) -> Bool {
    let text = String(decoding: frame, as: UTF8.self)
    var offset = text.startIndex
    for field in fields {
        guard let range = text.range(of: "\"\(field)\"", range: offset..<text.endIndex) else { return false }
        offset = range.upperBound
    }
    return true
}

private func strictVerifyRequest(_ request: [String: Any]) throws -> (
    challengeId: String,
    credentialId: String,
    signature: Data,
    commitment: String,
    operation: String,
    method: String,
    path: String,
    body: Data
) {
    let expected = ["version", "command", "challengeId", "credentialId", "signatureBase64url", "challengeCommitment", "operation", "requestMethod", "requestPath", "requestBodyBase64url"]
    guard request.count == expected.count, expected.allSatisfy({ request[$0] != nil }) else { throw BrokerFailure.malformed }
    guard
          request["version"] as? String == protocolVersion,
          request["command"] as? String == "verify",
          let challengeId = request["challengeId"] as? String, challengeId.hasPrefix("operator-challenge:"),
          let credentialId = request["credentialId"] as? String, credentialId.hasPrefix("credential:"),
          let signature = request["signatureBase64url"] as? String,
          let signatureBytes = canonicalBase64url(signature), signatureBytes.count == 64,
          let commitment = request["challengeCommitment"] as? String,
          commitment.count > 0, commitment.count <= maxFrame,
          let operation = request["operation"] as? String,
          operation == "open-session" || operation == "approve" || operation == "cancel-approval" ||
            operation == "seal-key-rotate" || operation == "seal-key-remove",
          let method = request["requestMethod"] as? String,
          (operation == "cancel-approval" ? method == "DELETE" :
            (operation == "seal-key-rotate" || operation == "seal-key-remove" ? method == "ADMIN" : method == "POST")),
          let path = request["requestPath"] as? String, path.count <= 2048, path.hasPrefix("/"),
          !path.unicodeScalars.contains(where: { $0.value <= 0x1f || $0.value == 0x7f || $0.value >= 0x80 }),
          let bodyText = request["requestBodyBase64url"] as? String,
          let body = canonicalBase64url(bodyText), body.count <= maxBody else {
        throw BrokerFailure.malformed
    }
    return (challengeId, credentialId, signatureBytes, commitment, operation, method, path, body)
}

private func strictSignRequest(_ request: [String: Any]) throws -> (
    challengeId: String,
    credentialId: String,
    commitment: String,
    operation: String,
    method: String,
    path: String,
    body: Data
) {
    let expected = ["version", "command", "challengeId", "credentialId", "challengeCommitment", "operation", "requestMethod", "requestPath", "requestBodyBase64url"]
    guard request.count == expected.count, expected.allSatisfy({ request[$0] != nil }) else { throw BrokerFailure.malformed }
    guard
        request["version"] as? String == protocolVersion,
        request["command"] as? String == "sign",
        let challengeId = request["challengeId"] as? String, challengeId.hasPrefix("operator-challenge:"),
        let credentialId = request["credentialId"] as? String, credentialId.hasPrefix("credential:"),
        let commitment = request["challengeCommitment"] as? String,
        commitment.count > 0, commitment.count <= maxFrame,
        let operation = request["operation"] as? String,
        operation == "open-session" || operation == "approve" || operation == "cancel-approval" ||
            operation == "seal-key-rotate" || operation == "seal-key-remove",
        let method = request["requestMethod"] as? String,
        (operation == "cancel-approval" ? method == "DELETE" :
            (operation == "seal-key-rotate" || operation == "seal-key-remove" ? method == "ADMIN" : method == "POST")),
        let path = request["requestPath"] as? String, path.count <= 2048, path.hasPrefix("/"),
        let bodyText = request["requestBodyBase64url"] as? String,
        let body = canonicalBase64url(bodyText), body.count <= maxBody, body.count > 0 else {
        throw BrokerFailure.malformed
    }
    return (challengeId, credentialId, commitment, operation, method, path, body)
}

private func canonicalInstant(_ date: Date) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.string(from: date)
}

private func signChallenge(_ request: [String: Any], privateRoot: String, configuration: BrokerConfiguration) throws -> [String: Any] {
    let values = try strictSignRequest(request)
    let currentObject = try loadConfigurationObject(privateRoot)
    let records = try credentialList(currentObject)
    guard let credential = records.first(where: { $0["credentialId"] as? String == values.credentialId && $0["status"] as? String == "active" }) else {
        throw BrokerFailure.unauthorized
    }
    let bodyHash = SHA256.hash(data: values.body).map { String(format: "%02x", $0) }.joined()
    guard let parsed = try? JSONSerialization.jsonObject(with: Data(values.commitment.utf8)) as? [Any],
          parsed.count == 15,
          parsed[0] as? String == "agent-mail-operator-challenge-v1",
          parsed[1] as? String == configuration.authorityInstanceId,
          parsed[2] as? String == values.challengeId,
          parsed[4] as? String == values.credentialId,
          parsed[5] as? String == operatorPrincipal,
          parsed[6] as? String == operatorProfile,
          parsed[7] as? String == values.operation,
          parsed[8] as? String == values.method,
          parsed[9] as? String == values.path,
          parsed[10] as? String == bodyHash,
          parsed[12] as? Int == configuration.revision,
          String(decoding: try canonicalJSON(parsed), as: UTF8.self) == values.commitment else {
        throw BrokerFailure.unauthorized
    }
    guard let display = parsed[11] as? String else { throw BrokerFailure.malformed }
    if values.operation == "open-session" {
        try strictSessionBody(values.body)
    }
    let bodyValue = values.operation == "open-session"
        ? nil
        : try strictActionBody(values.operation, values.body)
    guard parsed[11] as? String == displayCode(values.operation, values.body, configuration.authorityInstanceId),
          let issuedAt = parsed[13] as? String,
          let expiresAt = parsed[14] as? String,
          exactChallengeLifetime(issuedAt, expiresAt) else {
        throw BrokerFailure.unauthorized
    }
    let reason: String
    if values.operation == "approve" || values.operation == "cancel-approval" {
        guard let bodyValue,
              let planId = bodyValue["planId"] as? String,
              let previewDigest = bodyValue["previewDigest"] as? String else { throw BrokerFailure.malformed }
        let verb = values.operation == "approve" ? "APPROVE" : "CANCEL"
        reason = "Agent Mail \(verb) plan \(planId) preview \(previewDigest) code \(display)"
    } else if values.operation == "seal-key-rotate" || values.operation == "seal-key-remove" {
        guard let bodyValue,
              let revision = bodyValue["expectedKeyringRevision"] as? Int,
              let target = (values.operation == "seal-key-rotate" ? bodyValue["expectedActiveKeyId"] : bodyValue["keyId"]) as? String else {
            throw BrokerFailure.malformed
        }
        let verb = values.operation == "seal-key-rotate" ? "ROTATE" : "REMOVE"
        reason = "Agent Mail \(verb) approval seal key \(target) revision \(revision) code \(display)"
    } else {
        reason = "Agent Mail START 10-minute CREATE and INSPECT session"
    }
    let key = try secureKeyForCredential(credential)
    let signature = try signWithFreshPresence(key, Data(values.commitment.utf8), reason)
    return [
        "version": protocolVersion,
        "challengeId": values.challengeId,
        "credentialId": values.credentialId,
        "signatureBase64url": base64url(signature),
    ]
}

private func runOwnerOnlyServer(privateRoot: String) throws {
    try assertPrivateRoot(privateRoot)
    let socketPath = "\(privateRoot)/runtime/operator-presence.sock"
    let parent = (socketPath as NSString).deletingLastPathComponent
    try FileManager.default.createDirectory(atPath: parent, withIntermediateDirectories: true)
    guard chmod(parent, 0o700) == 0 else { throw BrokerFailure.unauthorized }
    var parentInfo = stat()
    guard lstat(parent, &parentInfo) == 0, (parentInfo.st_mode & S_IFMT) == S_IFDIR,
          (parentInfo.st_mode & 0o777) == 0o700, parentInfo.st_uid == getuid() else {
        throw BrokerFailure.unauthorized
    }
    guard getuid() == geteuid() else { throw BrokerFailure.unauthorized }
    var existingInfo = stat()
    if lstat(socketPath, &existingInfo) == 0 {
        guard (existingInfo.st_mode & S_IFMT) == S_IFSOCK,
              (existingInfo.st_mode & 0o777) == 0o600,
              existingInfo.st_uid == getuid() else {
            throw BrokerFailure.unauthorized
        }
        guard unlink(socketPath) == 0 else { throw BrokerFailure.unavailable }
    } else {
        guard errno == ENOENT else { throw BrokerFailure.unauthorized }
    }
    let listener = socket(AF_UNIX, SOCK_STREAM, 0)
    guard listener >= 0 else { throw BrokerFailure.unavailable }
    defer { close(listener); unlink(socketPath) }
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    socketPath.withCString { source in
        withUnsafeMutableBytes(of: &address.sun_path) { target in
            target.copyMemory(from: UnsafeRawBufferPointer(start: source, count: min(socketPath.utf8.count + 1, target.count)))
        }
    }
    let addressLength = socklen_t(MemoryLayout<sockaddr_un>.size)
    let bound = withUnsafePointer(to: &address) { pointer in
        pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(listener, $0, addressLength) }
    }
    guard bound == 0, chmod(socketPath, 0o600) == 0, listen(listener, 8) == 0 else { throw BrokerFailure.unavailable }
    while true {
        let client = accept(listener, nil, nil)
        if client < 0 { continue }
        defer { close(client) }
        guard ownerPeer(client) else { continue }
        do {
            let frame = try readOneFrame(client)
            let object = try JSONSerialization.jsonObject(with: frame) as? [String: Any]
            guard let object else { throw BrokerFailure.malformed }
            if object["command"] as? String == "sign" {
                guard hasCanonicalFieldOrder(frame, ["version", "command", "challengeId", "credentialId", "challengeCommitment", "operation", "requestMethod", "requestPath", "requestBodyBase64url"]) else { throw BrokerFailure.malformed }
                let configuration = try loadConfiguration(privateRoot)
                try writeResponse(client, signChallenge(object, privateRoot: privateRoot, configuration: configuration))
            } else if object["command"] as? String == "verify" {
                guard hasCanonicalFieldOrder(frame, ["version", "command", "challengeId", "credentialId", "signatureBase64url", "challengeCommitment", "operation", "requestMethod", "requestPath", "requestBodyBase64url"]) else { throw BrokerFailure.malformed }
                let values = try strictVerifyRequest(object)
                let configuration = try loadConfiguration(privateRoot)
                let records = try credentialList(try loadConfigurationObject(privateRoot))
                guard let credential = records.first(where: { $0["credentialId"] as? String == values.credentialId && $0["status"] as? String == "active" }) else {
                    throw BrokerFailure.unauthorized
                }
                let bodyHash = SHA256.hash(data: values.body).map { String(format: "%02x", $0) }.joined()
                guard let parsed = try? JSONSerialization.jsonObject(with: Data(values.commitment.utf8)) as? [Any],
                      parsed.count == 15,
                      parsed[0] as? String == "agent-mail-operator-challenge-v1",
                      parsed[1] as? String == configuration.authorityInstanceId,
                      parsed[2] as? String == values.challengeId,
                      parsed[4] as? String == values.credentialId,
                      parsed[7] as? String == values.operation,
                      parsed[8] as? String == values.method,
                      parsed[9] as? String == values.path,
                      parsed[10] as? String == bodyHash,
                      parsed[12] as? Int == configuration.revision,
                      String(decoding: try canonicalJSON(parsed), as: UTF8.self) == values.commitment else {
                    throw BrokerFailure.unauthorized
                }
                try verifyLowSignature(try secureKeyForCredential(credential), Data(values.commitment.utf8), values.signature)
                try writeResponse(client, ["verified": true])
            } else {
                // Challenge issuance is daemon-owned and durable. The native
                // process is a signer/verifier only; it never invents nonce,
                // challenge ID, timestamps, or commitment bytes.
                throw BrokerFailure.unauthorized
            }
        } catch {
            try? writeErrorResponse(client)
        }
    }
}

private func runProvisioningCommand(_ command: String, _ privateRoot: String, _ credentialId: String?) throws {
    let loadedConfiguration = try loadConfigurationObjectIfPresent(privateRoot)
    let configuration = loadedConfiguration ?? [
        "schemaVersion": 1,
        "authorityInstanceId": "instance:\(UUID().uuidString.lowercased())",
        "configurationRevision": 1,
        "updatedAt": canonicalInstant(Date()),
        "credentials": [[String: Any]](),
    ]
    let records = try credentialList(configuration)
    let current = activeCredential(records)
    let requestedAt = canonicalInstant(Date())

    switch command {
    case "enroll":
        guard current == nil else { throw BrokerFailure.unauthorized }
        let material = try enrollmentMaterial(
            authorityInstanceId: configuration["authorityInstanceId"] as? String ?? "",
            reason: "Agent Mail ENROLL operator key",
        )
        let retained = Array(records.suffix(1)) + [material.credential]
        let next: [String: Any]
        if loadedConfiguration == nil {
            next = [
                "schemaVersion": 1,
                "authorityInstanceId": configuration["authorityInstanceId"] as Any,
                "configurationRevision": 1,
                "updatedAt": requestedAt,
                "credentials": retained,
            ]
        } else {
            next = try nextConfiguration(configuration, credentials: retained, updatedAt: requestedAt)
        }
        try submitMutation(privateRoot, [
            "kind": "enroll",
            "configuration": next,
            "enrollmentCommitment": material.proof["enrollmentCommitment"] as Any,
            "signatureP1363Base64url": material.proof["signatureP1363Base64url"] as Any,
        ])

    case "rotate":
        guard let current, let currentCredentialId = current["credentialId"] as? String,
              let currentKey = try? secureKeyForCredential(current) else { throw BrokerFailure.unauthorized }
        let authorityInstanceId = configuration["authorityInstanceId"] as? String ?? ""
        let replacement = try enrollmentMaterial(
            authorityInstanceId: authorityInstanceId,
            reason: "Agent Mail ENROLL replacement operator key",
        )
        guard let replacementId = replacement.credential["credentialId"] as? String,
              let replacementHash = replacement.credential["publicKeySpkiSha256"] as? String else {
            throw BrokerFailure.unavailable
        }
        let administrationNonce = try randomBase64url(32)
        let rotationCommitment = try canonicalJSON([
            "agent-mail-operator-rotation-v1", authorityInstanceId, currentCredentialId,
            replacementId, replacementHash, requestedAt, administrationNonce,
        ])
        let rotationSignature = try administrativeSignature(
            currentKey,
            commitment: rotationCommitment,
            reason: "Agent Mail ROTATE current operator key",
        )
        var revoked = current
        revoked["status"] = "revoked"
        revoked["revokedAt"] = requestedAt
        revoked["replacedByCredentialId"] = replacementId
        let next = try nextConfiguration(configuration, credentials: [revoked, replacement.credential], updatedAt: requestedAt)
        try submitMutation(privateRoot, [
            "kind": "rotate",
            "configuration": next,
            "currentCredentialId": currentCredentialId,
            "rotationCommitment": String(decoding: rotationCommitment, as: UTF8.self),
            "rotationSignatureP1363Base64url": rotationSignature,
            "replacementEnrollmentCommitment": replacement.proof["enrollmentCommitment"] as Any,
            "replacementEnrollmentSignatureP1363Base64url": replacement.proof["signatureP1363Base64url"] as Any,
        ])

    case "revoke":
        guard let credentialId, let index = records.firstIndex(where: { $0["credentialId"] as? String == credentialId }),
              records[index]["status"] as? String == "active" else { throw BrokerFailure.unauthorized }
        let credential = records[index]
        let key = try secureKeyForCredential(credential)
        let authorityInstanceId = configuration["authorityInstanceId"] as? String ?? ""
        let administrationNonce = try randomBase64url(32)
        let revocationCommitment = try canonicalJSON([
            "agent-mail-operator-revocation-v1", authorityInstanceId, credentialId,
            requestedAt, administrationNonce,
        ])
        let revocationSignature = try administrativeSignature(
            key,
            commitment: revocationCommitment,
            reason: "Agent Mail REVOKE operator key",
        )
        var revoked = credential
        revoked["status"] = "revoked"
        revoked["revokedAt"] = requestedAt
        var nextRecords = records
        nextRecords[index] = revoked
        let next = try nextConfiguration(configuration, credentials: nextRecords, updatedAt: requestedAt)
        try submitMutation(privateRoot, [
            "kind": "revoke",
            "configuration": next,
            "credentialId": credentialId,
            "revocationCommitment": String(decoding: revocationCommitment, as: UTF8.self),
            "revocationSignatureP1363Base64url": revocationSignature,
        ])

    case "recover":
        guard loadedConfiguration != nil else { throw BrokerFailure.unauthorized }
        _ = try freshOwnerPresence("Agent Mail RECOVER operator authority")
        let newInstance = "instance:\(UUID().uuidString.lowercased())"
        let replacement = try enrollmentMaterial(
            authorityInstanceId: newInstance,
            reason: "Agent Mail ENROLL recovered operator key",
        )
        let revoked = records.compactMap { record -> [String: Any]? in
            guard let credentialId = record["credentialId"] as? String else { return nil }
            var value = record
            value["status"] = "revoked"
            value["revokedAt"] = requestedAt
            value["replacedByCredentialId"] = replacement.credential["credentialId"] ?? NSNull()
            _ = credentialId
            return value
        }
        let retained = Array(revoked.suffix(1)) + [replacement.credential]
        let next = try nextConfiguration(configuration, authorityInstanceId: newInstance, credentials: retained, updatedAt: requestedAt)
        try submitMutation(privateRoot, [
            "kind": "recover",
            "configuration": next,
            "replacementEnrollmentCommitment": replacement.proof["enrollmentCommitment"] as Any,
            "replacementEnrollmentSignatureP1363Base64url": replacement.proof["signatureP1363Base64url"] as Any,
        ])

    default:
        throw BrokerFailure.malformed
    }
}

// The production build invokes this executable with `enroll`, `rotate`,
// `revoke`, or `recover` during owner-only provisioning ceremonies. These
// commands never publish configuration/keyring files: they submit only the
// strict ceremony proof to the daemon mutation socket. The daemon command path
// accepts no software key, secret, or biometric fallback.
let arguments = Array(CommandLine.arguments.dropFirst())
guard let command = arguments.first else { throw BrokerFailure.malformed }
let privateRoot: String
let provisioningCommand: String
if command == "seal-key" {
    guard arguments.count == 4 || arguments.count == 6,
          arguments[2] == "--private-root" else { throw BrokerFailure.malformed }
    let subcommand = arguments[1]
    guard subcommand == "rotate" || (subcommand == "remove" && arguments.count == 6 && arguments[4] == "--key-id" && arguments[5].hasPrefix("approval-seal-key:")) else {
        throw BrokerFailure.malformed
    }
    provisioningCommand = "seal-key-\(subcommand)"
    privateRoot = arguments[3]
} else if command == "revoke" {
    guard arguments.count == 5, arguments[1] == "--private-root", arguments[3] == "--credential-id",
          arguments[4].hasPrefix("credential:") else { throw BrokerFailure.malformed }
    provisioningCommand = command
    privateRoot = arguments[2]
} else {
    guard arguments.count == 3, arguments[1] == "--private-root" else {
        throw BrokerFailure.malformed
    }
    provisioningCommand = command
    privateRoot = arguments[2]
}
guard isatty(STDIN_FILENO) == 1 || command == "serve" else { throw BrokerFailure.unauthorized }
switch provisioningCommand {
case "serve":
    try runOwnerOnlyServer(privateRoot: privateRoot)
case "enroll", "rotate", "revoke", "recover":
    try runProvisioningCommand(provisioningCommand, privateRoot, provisioningCommand == "revoke" ? arguments[4] : nil)
case "seal-key-rotate":
    try runSealKeyCommand("rotate", privateRoot, nil)
case "seal-key-remove":
    try runSealKeyCommand("remove", privateRoot, arguments[5])
default:
    throw BrokerFailure.malformed
}
