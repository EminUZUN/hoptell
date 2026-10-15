// Tests only (node --import): the restore crash point for `hoptell relay admin restore`, from
// HOPTELL_RESTORE_TEST_CRASH. The shipped CLI reads only this hook, so the variable alone does nothing.
if (process.env.HOPTELL_RESTORE_TEST_CRASH) globalThis[Symbol.for("hoptell.test.restoreCrash")] = process.env.HOPTELL_RESTORE_TEST_CRASH;
