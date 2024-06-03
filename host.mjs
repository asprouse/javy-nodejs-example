import { readFile, writeFile, open } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WASI } from "wasi";

try {
  const [embeddedModule, providerModule] = await Promise.all([
    compileModule("./embedded.wasm"),
    compileModule("./provider.wasm"),
  ]);
  const result = await runJavy(providerModule, embeddedModule, { n: 100 });
  console.log("Success!", JSON.stringify(result, null, 2));
} catch (e) {
  console.log(e);
}

async function compileModule(wasmPath) {
  const bytes = await readFile(new URL(wasmPath, import.meta.url));
  return WebAssembly.compile(bytes);
}

async function runJavy(providerModule, embeddedModule, input) {
  const uniqueId = crypto.randomUUID();

  // Use stdin/stdout/stderr to communicate with WASM process
  // See https://k33g.hashnode.dev/wasi-communication-between-nodejs-and-wasm-modules-another-way-with-stdin-and-stdout
  const workDir = tmpdir();
  const stdinFilePath = join(workDir, `stdin.wasm.${uniqueId}.txt`);
  const stdoutFilePath = join(workDir, `stdout.wasm.${uniqueId}.txt`);
  const stderrFilePath = join(workDir, `stderr.wasm.${uniqueId}.txt`);

  // 👋 send data to the WASM program
  await writeFile(stdinFilePath, JSON.stringify(input), { encoding: "utf8" });

  const [stdinFile, stdoutFile, stderrFile] = await Promise.all([
    open(stdinFilePath, "r"),
    open(stdoutFilePath, "a"),
    open(stderrFilePath, "a"),
  ]);

  try {
    const wasi = new WASI({
      version: "preview1",
      args: [],
      env: {},
      stdin: stdinFile.fd,
      stdout: stdoutFile.fd,
      stderr: stderrFile.fd,
      returnOnExit: true,
    });

    const providerInstance = await WebAssembly.instantiate(
      providerModule,
      wasi.getImportObject(),
    );
    const instance = await WebAssembly.instantiate(embeddedModule, {
      javy_quickjs_provider_v1: providerInstance.exports,
    });

    // Javy provider is a WASI reactor see https://github.com/WebAssembly/WASI/blob/main/legacy/application-abi.md?plain=1
    wasi.initialize(providerInstance);
    instance.exports._start();

    const [out, err] = await Promise.all([
      readOutput(stdoutFilePath),
      readOutput(stderrFilePath),
    ]);

    if (err) {
      throw new Error(err);
    }

    return out;
  } catch (e) {
    if (e instanceof WebAssembly.RuntimeError) {
      const errorMessage = await readOutput(stderrFilePath);
      if (errorMessage) {
        throw new Error(errorMessage);
      }
    }
    throw e;
  } finally {
    await Promise.all([
      stdinFile.close(),
      stdoutFile.close(),
      stderrFile.close(),
    ]);
  }
}

async function readOutput(filePath) {
  const str = (await readFile(filePath, "utf8")).trim();
  try {
    return JSON.parse(str);
  } catch {
    return str;
  }
}
