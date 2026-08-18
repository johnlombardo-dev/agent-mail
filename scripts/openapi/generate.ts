import { publicOperationRegistry } from "../../packages/daemon/src/http";
import { httpErrorRegistry } from "../../packages/contracts/src/index";
import { resolve } from "node:path";
import {
  assertOpenApi31,
  assertOpenApiCompleteness,
  generateOpenApiDocument,
  stableJson,
} from "../../packages/contracts/src/openapi";

const output = new URL("../../docs/openapi.json", import.meta.url);
const document = generateOpenApiDocument(publicOperationRegistry, httpErrorRegistry);
assertOpenApi31(document);
assertOpenApiCompleteness(publicOperationRegistry, document, httpErrorRegistry);
await Bun.write(output, stableJson(document));
const formatter = Bun.spawn(["vp", "fmt", "--write", resolve(output.pathname)], {
  stdout: "ignore",
  stderr: "inherit",
});
if ((await formatter.exited) !== 0) throw new Error("vp fmt failed for generated OpenAPI");
