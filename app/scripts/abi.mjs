// Copies the MergePay ABI from the Foundry build into the worker and the frontend.
import { readFileSync, writeFileSync } from "node:fs";
const { abi } = JSON.parse(readFileSync(new URL("../../contracts/out/MergePay.sol/MergePay.json", import.meta.url)));
const json = JSON.stringify(abi);
writeFileSync(new URL("../src/abi.ts", import.meta.url), `export const abi = ${json} as const;\n`);
writeFileSync(new URL("../public/abi.js", import.meta.url), `export const abi = ${json};\n`);
console.log(`abi: ${abi.length} entries`);
