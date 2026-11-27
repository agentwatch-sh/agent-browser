// The rights helper of the Mac sign-in window probe (probe.ts; board ab-v16.97.14, part 1; the design note's D1). The
// probe starts it with its own Node and the one word `rights`. It answers whether a program that an agent's shell runs
// on this Mac already holds two rights of macOS's privacy control (TCC), by the two calls that Apple documents as
// reads with no prompt:
//
//   CGPreflightScreenCaptureAccess()   (CoreGraphics; "checks whether the current process already has screen capture
//                                       access"; CGRequestScreenCaptureAccess is the call that can prompt: never called)
//   AXIsProcessTrusted()               (ApplicationServices; "returns whether the current process is a trusted
//                                       accessibility client"; AXIsProcessTrustedWithOptions with the prompt option is
//                                       the call that can prompt: never called)
//
// TCC gives a process the rights of its responsible process, so the answer holds for any program of the seat's shell
// (an agent's program runs the same way). It prints one JSON line on stdout and nothing else: {"screenRecording":
// true|false|null, "accessibility": true|false|null, "failed": null|"<why>"}. It reads no file and starts no process.
// On another system than the Mac it answers null and null with its reason.

const [mode] = process.argv.slice(2);
if (mode !== "rights" || process.argv.length !== 3) process.exit(2);

const CG = "/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics";
const AS = "/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices";

async function rights(): Promise<{ screenRecording: boolean | null; accessibility: boolean | null; failed: string | null }> {
  if (process.platform !== "darwin") return { screenRecording: null, accessibility: null, failed: `not the Mac (${process.platform})` };
  let ffi: any;
  try { const mod: any = await import("node:ffi"); ffi = mod.default ?? mod; }
  catch (e) { return { screenRecording: null, accessibility: null, failed: `node:ffi does not load (${(e as { code?: string }).code ?? "error"})` }; }
  const one = (lib: string, name: string): boolean | null => {
    try {
      const f = ffi.dlopen(lib, { [name]: { return: "uint8", arguments: [] } }).functions[name];
      return (f() & 0xff) !== 0;
    } catch { return null; }
  };
  const screenRecording = one(CG, "CGPreflightScreenCaptureAccess");
  const accessibility = one(AS, "AXIsProcessTrusted");
  return { screenRecording, accessibility, failed: screenRecording === null || accessibility === null ? "a call did not load" : null };
}

process.stdout.write(`${JSON.stringify(await rights())}\n`, () => process.exit(0));
