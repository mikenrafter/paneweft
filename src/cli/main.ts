// `paneweft` command line (design section 5). Every operation command is a thin adapter over
// executeOperation and accepts the MCP tool's arguments verbatim as `--args '<json>'`,
// `--args-file FILE` or `--args-file -` (stdin), so CLI and MCP can be fed the same request bytes.
// Ergonomic flags are sugar for the same arguments. docs/red-contract.md "CLI" is normative.
//
// Exit codes: 0 ok; 1 operation error (error body on stdout); 2 usage error (message on stderr).
export interface CliIo {
  stdin: string | null;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: Record<string, string | undefined>;
  cwd: string;
}

/** STUB: reports a usage error. */
export async function runCli(_argv: string[], io: CliIo): Promise<number> {
  io.stderr("paneweft: not implemented\n");
  return 2;
}
