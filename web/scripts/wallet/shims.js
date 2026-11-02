// Browser shims some NEAR packages expect from Node.
import { Buffer } from "buffer"; import process from "process"; globalThis.Buffer ??= Buffer; globalThis.process ??= process; export { Buffer, process };
