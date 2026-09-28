import solc from "solc";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
const CONTRACTS = ["Settlement", "TestUSDC", "CommissionEscrow"] as const;
export function compile() {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const sources = Object.fromEntries(
    CONTRACTS.map((name) => [
      `${name}.sol`,
      {
        content: readFileSync(
          resolve(root, "contracts", `${name}.sol`),
          "utf8",
        ),
      },
    ]),
  );
  const output = JSON.parse(
    solc.compile(
      JSON.stringify({
        language: "Solidity",
        sources,
        settings: {
          optimizer: { enabled: true, runs: 200 },
          evmVersion: "shanghai",
          outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object", "evm.deployedBytecode.immutableReferences"] } },
        },
      }),
      {
        import: (path: string) => {
          try {
            return {
              contents: readFileSync(
                resolve(root, "node_modules", path),
                "utf8",
              ),
            };
          } catch {
            return { error: `Missing import ${path}` };
          }
        },
      },
    ),
  );
  const errors = (output.errors ?? []).filter(
    (e: { severity: string }) => e.severity === "error",
  );
  if (errors.length)
    throw new Error(
      errors
        .map((e: { formattedMessage: string }) => e.formattedMessage)
        .join("\n"),
    );
  return Object.fromEntries(
    CONTRACTS.map((name) => [
      name,
      {
        abi: output.contracts[`${name}.sol`][name].abi,
        deployedBytecode: `0x${output.contracts[`${name}.sol`][name].evm.deployedBytecode.object}` as `0x${string}`,
        immutableReferences: output.contracts[`${name}.sol`][name].evm.deployedBytecode.immutableReferences as Record<string, {start:number;length:number}[]>,
        bytecode:
          `0x${output.contracts[`${name}.sol`][name].evm.bytecode.object}` as `0x${string}`,
      },
    ]),
  ) as Record<(typeof CONTRACTS)[number], { abi: any; bytecode: `0x${string}`; deployedBytecode: `0x${string}`; immutableReferences: Record<string, {start:number;length:number}[]> }>;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  mkdirSync(".local/artifacts", { recursive: true });
  for (const [name, artifact] of Object.entries(compile()))
    writeFileSync(
      `.local/artifacts/${name}.json`,
      JSON.stringify(artifact, null, 2),
    );
  console.log(
    "Compiled Settlement, TestUSDC, and CommissionEscrow (Settlement supports BOT Chain; other contracts remain test-only).",
  );
}
