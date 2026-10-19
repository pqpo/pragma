import { probePiModelProvider } from "@pragma/runtime-pi";
import { createModelConnectionTester } from "@pragma/local-host/deployment";
export const testProviderModel = createModelConnectionTester(probePiModelProvider);
