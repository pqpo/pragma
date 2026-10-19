import process from "node:process";
import { readFile } from "node:fs/promises";
import { PragmaPaths } from "@pragma/core";
import {
  createContextStoreStore,
  createPragmaBundleService,
  createPragmaProjectStore,
  createWorkflowLayoutStore,
} from "../../dist/deployment/index.js";

const configuration = JSON.parse(await readFile(process.argv[2], "utf8"));
const paths = new PragmaPaths({ pragmaHome: configuration.pragmaHome });
const project = createPragmaProjectStore({
  projectsPath: paths.projectsRoot(),
  objectsPath: paths.contentObjectsRoot(),
  projectViewsPath: paths.projectViewsCacheRoot(),
});
const contextStores = createContextStoreStore({ storesPath: configuration.contextStoresPath });
const interrupt = (owner, method, phase) =>
  new Proxy(owner, {
    get(target, property, receiver) {
      if (property !== method) return Reflect.get(target, property, receiver);
      return async (...args) => {
        const result = await target[method](...args);
        if (configuration.phase === phase) process.kill(process.pid, "SIGKILL");
        return result;
      };
    },
  });
const service = createPragmaBundleService({
  paths,
  project: interrupt(project, "publish", "publication"),
  contextStores: interrupt(contextStores, "createFromSnapshot", "asset"),
  capabilities: { list: async () => [] },
  plugins: { list: async () => [] },
  layouts: createWorkflowLayoutStore({ projectsPath: paths.projectsRoot() }),
  getRuntimes: async () => [],
});
const result = await service.startImport(configuration.request);
throw new Error(`The crash boundary was not reached: ${result.status}: ${result.error ?? ""}`);
