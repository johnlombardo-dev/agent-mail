import { readFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publicOperationRegistry } from "../../packages/daemon/src/http";
import { httpErrorRegistry } from "../../packages/contracts/src/index";
import {
  assertOpenApi31,
  assertOpenApiCompleteness,
  generateOpenApiDocument,
  stableJson,
  type OpenApiDocument,
} from "../../packages/contracts/src/openapi";

const output = new URL("../../docs/openapi.json", import.meta.url);
const checked = JSON.parse(readFileSync(output, "utf8")) as OpenApiDocument;
assertOpenApi31(checked);
assertOpenApiCompleteness(publicOperationRegistry, checked, httpErrorRegistry);
const temporaryPaths = [
  join(tmpdir(), `agent-mail-openapi-${process.pid}-1.json`),
  join(tmpdir(), `agent-mail-openapi-${process.pid}-2.json`),
];
try {
  for (const path of temporaryPaths) {
    await Bun.write(
      path,
      stableJson(generateOpenApiDocument(publicOperationRegistry, httpErrorRegistry)),
    );
    const formatter = Bun.spawn(["vp", "fmt", "--write", path], {
      stdout: "ignore",
      stderr: "inherit",
    });
    if ((await formatter.exited) !== 0) throw new Error("vp fmt failed for generated OpenAPI");
  }
  const firstBytes = readFileSync(temporaryPaths[0]);
  const secondBytes = readFileSync(temporaryPaths[1]);
  const checkedBytes = readFileSync(output);
  if (!firstBytes.equals(secondBytes))
    throw new Error("OpenAPI generation is not byte deterministic");
  if (!checkedBytes.equals(firstBytes))
    throw new Error("checked OpenAPI document has byte drift; run bun scripts/openapi/generate.ts");
} finally {
  await Promise.all(temporaryPaths.map((path) => unlink(path).catch(() => undefined)));
}
console.log(
  `OpenAPI 3.1 valid: ${Object.keys(checked.paths).length} paths, ${Object.keys(checked.components.schemas).length} schemas`,
);
