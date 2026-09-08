import { z } from "zod";

export const ContextStoreRevisionChangeSchema = z
  .object({ storeId: z.string().uuid().optional() })
  .strict();

export {
  ContextStoreDraftRebaseInspectionSchema,
  ContextStoreDraftRefSchema,
  ContextStoreDraftSchema,
  ContextStoreDraftViewSchema,
  ContextStoreDraftStateSchema,
  CreateContextStoreDraftSchema,
  GetContextStoreDraftFileSchema,
  ContextStoreRevisionJobRefSchema,
  ContextStoreRevisionJobSchema,
  ContextStoreRevisionJobStateSchema,
  ContextStoreRevisionProfileSchema,
  ContextStoreRevisionRequestSchema,
  ListContextStoreRevisionJobsSchema,
  ListContextStoreDraftsSchema,
  RebaseContextStoreDraftSchema,
  SubmitContextStoreDraftSchema,
  UpdateContextStoreDraftFileSchema,
  UpdateContextStoreRevisionProfileSchema,
} from "@pragma/built-in-agents/contracts";
