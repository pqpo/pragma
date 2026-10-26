# Compiler v11 historical writer

Generated with the unmodified Interpreter sources at `d6623c1e`, using
`loadPragmaProject` and `PragmaProject.createLock` before updating the compiler.
The fixture contains all six lifecycle approval keys plus unrelated MCP policies.
The v11 lock, resource hashes and project fingerprint are actual writer output.

The v11→v12 step validates the original lock and preserves resource bytes and
policies. Lifecycle approvals are inert at execution; unrelated policies remain
enforced. Published sources are never rewritten.
