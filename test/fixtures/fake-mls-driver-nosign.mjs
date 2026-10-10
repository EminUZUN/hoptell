// The fake MLS driver without SignWithLabel (driver.signing false), for HOPTELL_MLS_DRIVER: a
// binding that cannot sign hoptell's statements (amendments-3.5-prep A3).
import crypto from "node:crypto";
import { createFakeDriver } from "../fake-mls-driver.js";

export const driver = createFakeDriver({ seed: process.env.HOPTELL_FAKE_MLS_SEED || crypto.randomBytes(16).toString("hex"), signing: false });
