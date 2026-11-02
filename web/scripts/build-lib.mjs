// Compiles the agent's pure TypeScript (policy and simulator) to browser JavaScript in web/lib, so the site runs
// exactly the code the live agent runs. Zero dependencies: uses Node's built-in type stripping (Node >= 22.13).
//   node web/scripts/build-lib.mjs
import { stripTypeScriptTypes } from "node:module";
import fs from "node:fs";
import path from "node:path";

const here = import.meta.dirname;
const src = path.resolve(here, "../../agent/src");
const out = path.resolve(here, "../lib");
for (const name of ["policy", "sim"]) {
  const ts = fs.readFileSync(path.join(src, `${name}.ts`), "utf8");
  const js = stripTypeScriptTypes(ts, { mode: "strip" })
    .replace(/from "\.\/(\w+)\.ts"/g, 'from "./$1.js"')
    .replace(/^import \{\s*\} from .*$/m, "");
  const header = `// GENERATED from agent/src/${name}.ts by web/scripts/build-lib.mjs. Do not edit; rerun the script.\n`;
  fs.writeFileSync(path.join(out, `${name}.js`), header + js);
  console.log(`web/lib/${name}.js`);
}
