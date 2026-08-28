import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "accuse-relance-settings-test-"));
process.env.DB_PATH = path.join(dir, "test.db");
process.env.CATEGORIES_CONFIG_PATH = path.resolve("config/categories.json");
