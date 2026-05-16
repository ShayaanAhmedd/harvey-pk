import { spawn } from "child_process";
import path from "path";

export type IngestParams = {
  file: string;          // absolute path to downloaded file
  act: string;           // legal Act name (e.g., "Theft Act 1968")
  year?: number;
  jurisdiction: string;  // "UK" | "Pakistan"
  sourceUrl: string;     // original government URL
};

export async function runIngestLaw(params: IngestParams): Promise<{ success: boolean; output: string }> {
  return new Promise((resolve) => {
    // Build argument list with explicit quoting for multi-word values.
    // Resolve the tsx binary directly so we don't need a shell, which on
    // Windows splits multi-word values like "Pakistan Penal Code 1860" on
    // whitespace and truncates --act to its first token.
    const tsxPath = path.resolve(process.cwd(), "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
    const scriptPath = path.resolve(process.cwd(), "scripts", "ingest-law.ts");

    const args = [
      scriptPath,
      "--file", params.file,
      "--act", params.act,
      "--jurisdiction", params.jurisdiction,
      "--source-url", params.sourceUrl,
    ];
    if (params.year) {
      args.push("--year", String(params.year));
    }

    const child = spawn(tsxPath, args, {
      cwd: process.cwd(),
      shell: false,                       // CRITICAL: shell:false preserves arg boundaries
      env: { ...process.env },
      windowsVerbatimArguments: false,
    });

    let output = "";
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      output += text;
      process.stdout.write(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      output += text;
      process.stderr.write(text);
    });
    child.on("close", (code) => {
      resolve({ success: code === 0, output });
    });
    child.on("error", (err) => {
      console.error(`Spawn error: ${err.message}`);
      resolve({ success: false, output: err.message });
    });
  });
}
