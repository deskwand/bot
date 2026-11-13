// The test Worker (tests/worker.ts) additionally binds the test-only harness DO.
// Production bindings are generated into worker-configuration.d.ts from
// wrangler.jsonc; this augmentation only adds the test binding.
declare namespace Cloudflare {
  interface Env {
    TEST_HARNESS: DurableObjectNamespace<
      import("./test-harness-do").TestHarnessDO
    >;
    STORE_TEST: DurableObjectNamespace<
      import("../container/store/store-do").StoreDO
    >;
  }
}
