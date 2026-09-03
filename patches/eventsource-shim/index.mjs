import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const EventSource = require("./index.cjs");
export { EventSource };
export default EventSource;
