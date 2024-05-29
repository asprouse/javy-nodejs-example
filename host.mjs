import { readFile, writeFile, open } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WASI } from "wasi";

async function readOutput(filePath) {
  const str = (await readFile(filePath, "utf8")).trim();
  try {
    return JSON.parse(str);
  } catch {
    return str;
  }
}

async function run(wasmFilePath, input) {
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

    const embeddedModule = await WebAssembly.compile(
      await readFile(new URL(wasmFilePath, import.meta.url)),
    );

    const providerModule = await WebAssembly.compile(
      await readFile(new URL("./provider.wasm", import.meta.url)),
    );

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
    } else {
      throw e;
    }
  } finally {
    await Promise.all([
      stdinFile.close(),
      stdoutFile.close(),
      stderrFile.close(),
    ]);
  }
}

try {
  const result = await run("./embedded.wasm", { n: 100 });
  console.log("Success!", JSON.stringify(result, null, 2));
} catch (e) {
  console.log(e);
}
