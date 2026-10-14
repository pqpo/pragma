import { createPragmaLogger, moveOwnedStorageToTrash, PragmaPaths } from "@pragma/core";
import process from "node:process";
import { withMissionControllerDeletionBarrier } from "../../dist/missions/controller/storage-locks.js";
import { createMissionDeletionService } from "../../dist/missions/deletion.js";

const [pragmaHome, missionId, ownerPath] = process.argv.slice(2);
const paths = new PragmaPaths({ pragmaHome });
const service = createMissionDeletionService({
  paths,
  logger: createPragmaLogger(undefined, { component: "deletion-process-test" }),
  ports: {
    usage: async () => {},
    memory: async () => {},
    drafts: async () => {},
    claims: async () => {},
    settlement: async () => {},
  },
});
const record = await service.read(missionId);
process.send({ type: "waiting" });
await withMissionControllerDeletionBarrier(paths.missionsRoot(), missionId, async () => {
  await moveOwnedStorageToTrash({
    paths,
    deletionId: record.deletionId,
    owner: { type: "mission", id: missionId },
    sources: [{ label: "mission", path: ownerPath }],
    onCommitted: async () => await service.commit(missionId),
  });
});
process.disconnect();
