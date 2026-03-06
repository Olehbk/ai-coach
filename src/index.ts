import "dotenv/config";
import { startServer } from "./server.js";
import { startScheduler } from "./scheduler.js";

startServer();
startScheduler();
