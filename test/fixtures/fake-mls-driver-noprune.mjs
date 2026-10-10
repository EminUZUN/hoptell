// The fake MLS driver without KeyPackage pruning (no driver.pruneKeyPackages), for
// HOPTELL_MLS_DRIVER: a binding without prune_key_packages (amendments 3.5 part 2, A10).
import crypto from "node:crypto";
import { createFakeDriver } from "../fake-mls-driver.js";

export const driver = createFakeDriver({ seed: process.env.HOPTELL_FAKE_MLS_SEED || crypto.randomBytes(16).toString("hex"), prune: false });
