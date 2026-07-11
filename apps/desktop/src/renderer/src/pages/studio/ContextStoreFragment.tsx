import {
  BookOpenText,
  CaretRight,
  Check,
  Database,
  FileText,
  Folder,
  MagnifyingGlass,
  Plus,
  X,
} from "@phosphor-icons/react";
import type { ContextTrigger } from "@pragma/shared";
import { useMemo, useState } from "react";

import type {
  ContextNoteEntry,
  ContextStore,
  CreateContextStore,
  ExpertContextStoreMount,
} from "../../../../shared/desktop-api.ts";
import { errorMessage } from "../../lib/errors.ts";

type StoreFilter = "all" | ContextStore["type"];
type CreateStep = "type" | "configure" | "review";

function triggerLabel(trigger: ContextTrigger): string {
  if (trigger === "always_on") return "Load immediately";
  if (trigger === "model_decision") return "Model decides";
  return "On demand";
}

export function ContextStoreDirectoryFragment(props: {
  readonly stores: readonly ContextStore[];
  readonly onCreate: (input: CreateContextStore) => Promise<ContextStore>;
  readonly onAddNoteEntry: (storeId: string, entry: ContextNoteEntry) => Promise<ContextStore>;
  readonly onPickFolder: () => Promise<string | undefined>;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<StoreFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(props.stores[0]?.id ?? null);
  const [creating, setCreating] = useState(false);
  const stores = useMemo(
    () =>
      props.stores.filter((store) => {
        const matchesFilter = filter === "all" || store.type === filter;
        const matchesQuery = `${store.name} ${store.description}`
          .toLowerCase()
          .includes(query.trim().toLowerCase());
        return matchesFilter && matchesQuery;
      }),
    [filter, props.stores, query],
  );
  const selected = stores.find((store) => store.id === selectedId) ?? stores[0];

  return (
    <section className="context-store-directory" aria-labelledby="context-stores-heading">
      <header className="studio-heading expert-directory-heading">
        <div>
          <h1 id="context-stores-heading">Context stores</h1>
          <p>Reusable knowledge sources for your experts.</p>
        </div>
        <button className="primary-button" type="button" onClick={() => setCreating(true)}>
          <Plus size={17} aria-hidden="true" />
          Create store
        </button>
      </header>

      <div className="store-filter-tabs" aria-label="Filter context stores">
        {(["all", "file", "note"] as const).map((value) => (
          <button
            className={filter === value ? "is-active" : ""}
            key={value}
            type="button"
            onClick={() => setFilter(value)}
          >
            {value === "all" ? "All" : value === "file" ? "Files" : "Context notes"}
          </button>
        ))}
      </div>

      <label className="directory-search store-search">
        <MagnifyingGlass size={18} aria-hidden="true" />
        <span className="sr-only">Search stores</span>
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search stores"
        />
      </label>

      {stores.length === 0 ? (
        <div className="empty-state store-empty-state">
          <Database size={28} aria-hidden="true" />
          <h3>{props.stores.length === 0 ? "No context stores yet" : "No matching stores"}</h3>
          <p>
            {props.stores.length === 0
              ? "Create a file store or context note, then mount it to one or more experts."
              : "Try another search or filter."}
          </p>
          {props.stores.length === 0 ? (
            <button className="primary-button" type="button" onClick={() => setCreating(true)}>
              Create store
            </button>
          ) : null}
        </div>
      ) : (
        <div className="store-directory-layout">
          <div className="store-table" role="list" aria-label="Context stores">
            <div className="store-table-heading" aria-hidden="true">
              <span>Store</span>
              <span>Type</span>
              <span>Source</span>
              <span>Status</span>
            </div>
            {stores.map((store) => {
              const StoreIcon = store.type === "file" ? Folder : BookOpenText;
              return (
                <button
                  className={
                    store.id === selected?.id ? "store-list-row is-selected" : "store-list-row"
                  }
                  key={store.id}
                  type="button"
                  onClick={() => setSelectedId(store.id)}
                >
                  <span className="store-list-name">
                    <span className="store-icon" aria-hidden="true">
                      <StoreIcon size={22} />
                    </span>
                    <span>
                      <strong>{store.name}</strong>
                      <small>{store.description || "No description"}</small>
                    </span>
                  </span>
                  <span>{store.type === "file" ? "File store" : "Context note"}</span>
                  <span className="store-source">
                    {store.type === "file" ? store.source.path : `${store.entries.length} entries`}
                  </span>
                  <span className="store-status">
                    <i className={store.status === "ready" ? "is-ready" : ""} />
                    {store.status === "ready" ? "Ready" : "Configured"}
                  </span>
                  <CaretRight size={17} aria-hidden="true" />
                </button>
              );
            })}
            <p className="directory-count">{stores.length} stores</p>
          </div>
          {selected ? (
            <ContextStoreDetail store={selected} onAddNoteEntry={props.onAddNoteEntry} />
          ) : null}
        </div>
      )}

      {creating ? (
        <ContextStoreCreatorDrawer
          onClose={() => setCreating(false)}
          onCreate={props.onCreate}
          onCreated={(store) => {
            setSelectedId(store.id);
            setCreating(false);
          }}
          onPickFolder={props.onPickFolder}
        />
      ) : null}
    </section>
  );
}

function ContextStoreDetail(props: {
  readonly store: ContextStore;
  readonly onAddNoteEntry: (storeId: string, entry: ContextNoteEntry) => Promise<ContextStore>;
}) {
  const [addingEntity, setAddingEntity] = useState(false);
  const StoreIcon = props.store.type === "file" ? Folder : BookOpenText;
  return (
    <aside className="store-detail" aria-label={`${props.store.name} details`}>
      <div className="store-detail-title">
        <span className="store-icon" aria-hidden="true">
          <StoreIcon size={24} />
        </span>
        <div>
          <h2>{props.store.name}</h2>
          <p>{props.store.description || "No description"}</p>
        </div>
      </div>
      <dl>
        <div>
          <dt>Type</dt>
          <dd>{props.store.type === "file" ? "File store" : "Context note"}</dd>
        </div>
        <div>
          <dt>Access</dt>
          <dd>Read only</dd>
        </div>
        <div>
          <dt>{props.store.type === "file" ? "Source" : "Entries"}</dt>
          <dd>
            {props.store.type === "file"
              ? props.store.source.path
              : `${props.store.entries.length} context entries`}
          </dd>
        </div>
        <div>
          <dt>Availability</dt>
          <dd>{props.store.type === "file" ? "This device" : "Cloud and local runtimes"}</dd>
        </div>
        <div>
          <dt>Loading behavior</dt>
          <dd>
            {props.store.type === "file"
              ? "Read from file metadata; defaults to On demand"
              : props.store.entries.length === 1
                ? triggerLabel(props.store.entries[0]!.trigger)
                : "Configured per note entry"}
          </dd>
        </div>
      </dl>
      {props.store.type === "note" ? (
        <>
          <div className="context-entity-heading">
            <h3>Entities</h3>
            <button
              className="secondary-button"
              type="button"
              onClick={() => setAddingEntity(true)}
            >
              <Plus size={16} /> Add entity
            </button>
          </div>
          <div className="context-entity-list">
            {props.store.entries.length === 0 ? <p>No entities yet.</p> : null}
            {props.store.entries.map((entry) => (
              <article key={entry.id}>
                <strong>{entry.id}</strong>
                <p>{entry.description}</p>
                <small>{triggerLabel(entry.trigger)}</small>
              </article>
            ))}
          </div>
          {addingEntity ? (
            <ContextEntityCreatorDrawer
              store={props.store}
              onClose={() => setAddingEntity(false)}
              onCreate={props.onAddNoteEntry}
            />
          ) : null}
        </>
      ) : null}
    </aside>
  );
}

export function ContextStoreCreatorDrawer(props: {
  readonly onClose: () => void;
  readonly onCreate: (input: CreateContextStore) => Promise<ContextStore>;
  readonly onCreated: (store: ContextStore) => void;
  readonly onPickFolder: () => Promise<string | undefined>;
  readonly mountExpertName?: string;
}) {
  const [step, setStep] = useState<CreateStep>("type");
  const [type, setType] = useState<ContextStore["type"]>("file");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [path, setPath] = useState("");
  const [updateBehavior, setUpdateBehavior] = useState<"watch" | "manual">("watch");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const continueFromConfigure = () => {
    if (!name.trim() || (type === "file" && !path)) {
      setError(
        type === "file" ? "Name and source folder are required." : "Store name is required.",
      );
      return;
    }
    setError(null);
    setStep("review");
  };
  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      const common = { name: name.trim(), description: description.trim() };
      const input: CreateContextStore =
        type === "file"
          ? { type, ...common, source: { path, updateBehavior } }
          : { type, ...common };
      props.onCreated(await props.onCreate(input));
    } catch (submitError) {
      setSaving(false);
      setError(errorMessage(submitError));
    }
  };

  return (
    <div className="drawer-layer" role="presentation">
      <button
        className="drawer-scrim"
        type="button"
        aria-label="Close create store"
        onClick={props.onClose}
      />
      <aside className="store-creator-drawer" aria-labelledby="create-store-heading">
        <header className="drawer-heading">
          <h2 id="create-store-heading">Create store</h2>
          <button type="button" aria-label="Close" onClick={props.onClose}>
            <X size={22} />
          </button>
        </header>
        <ol className="drawer-steps" aria-label="Create store steps">
          {(["type", "configure", "review"] as const).map((item, index) => (
            <li className={step === item ? "is-active" : ""} key={item}>
              <span>{index + 1}</span>
              {item === "type" ? "Type" : item === "configure" ? "Configure" : "Review"}
            </li>
          ))}
        </ol>

        <div className="drawer-body">
          {step === "type" ? (
            <>
              <div className="drawer-copy">
                <h3>Choose a store type</h3>
                <p>Select where this store gets its knowledge.</p>
              </div>
              <div className="store-type-options">
                <button
                  className={type === "file" ? "is-selected" : ""}
                  type="button"
                  onClick={() => setType("file")}
                >
                  <Folder size={26} />
                  <span>
                    <strong>File store</strong>
                    <small>Index a folder on this device.</small>
                    <em>Available while this device is online.</em>
                  </span>
                  {type === "file" ? <Check size={18} /> : null}
                </button>
                <button
                  className={type === "note" ? "is-selected" : ""}
                  type="button"
                  onClick={() => setType("note")}
                >
                  <BookOpenText size={26} />
                  <span>
                    <strong>Context note</strong>
                    <small>Write rules, instructions, or reference text.</small>
                    <em>Available to cloud and local runtimes.</em>
                  </span>
                  {type === "note" ? <Check size={18} /> : null}
                </button>
                <button type="button" disabled>
                  <Database size={26} />
                  <span>
                    <strong>Connected store</strong>
                    <small>Sync knowledge from a third-party service.</small>
                    <em>Coming later</em>
                  </span>
                </button>
              </div>
            </>
          ) : null}

          {step === "configure" ? (
            <>
              <div className="drawer-copy">
                <h3>{type === "file" ? "Configure file store" : "Write context note"}</h3>
                <p>
                  {type === "file"
                    ? "Choose a local folder this store can read."
                    : "Add concise context that experts can apply or retrieve."}
                </p>
              </div>
              <div className="store-config-form">
                <label>
                  Store name
                  <input value={name} onChange={(event) => setName(event.target.value)} autoFocus />
                </label>
                <label>
                  Description
                  <textarea
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                  />
                </label>
                {type === "file" ? (
                  <>
                    <label>
                      Source folder
                      <span className="folder-picker">
                        <input value={path} readOnly placeholder="Choose a folder" />
                        <button
                          className="secondary-button"
                          type="button"
                          onClick={() =>
                            void props.onPickFolder().then((folder) => folder && setPath(folder))
                          }
                        >
                          Choose folder
                        </button>
                      </span>
                    </label>
                    <label>
                      Update behavior
                      <select
                        value={updateBehavior}
                        onChange={(event) =>
                          setUpdateBehavior(event.target.value as typeof updateBehavior)
                        }
                      >
                        <option value="watch">Watch for changes</option>
                        <option value="manual">Refresh manually</option>
                      </select>
                    </label>
                    {path ? (
                      <p className="store-availability-note">
                        <Check size={17} /> Folder configured. Indexing will start when the context
                        runtime is enabled.
                      </p>
                    ) : null}
                  </>
                ) : (
                  <p className="store-availability-note">
                    Create the store first, then add one or more context entities from its detail
                    page.
                  </p>
                )}
              </div>
            </>
          ) : null}

          {step === "review" ? (
            <>
              <div className="drawer-copy">
                <h3>Review {type === "file" ? "file store" : "context note"}</h3>
                <p>Confirm what will be created{props.mountExpertName ? " and mounted" : ""}.</p>
              </div>
              <dl className="store-review-list">
                <div>
                  <dt>Name</dt>
                  <dd>{name}</dd>
                </div>
                <div>
                  <dt>Type</dt>
                  <dd>{type === "file" ? "File store" : "Context note"}</dd>
                </div>
                <div>
                  <dt>Access</dt>
                  <dd>Read only</dd>
                </div>
                {type === "file" ? (
                  <div>
                    <dt>Source</dt>
                    <dd>{path}</dd>
                  </div>
                ) : null}
              </dl>
              {props.mountExpertName ? (
                <div className="mount-destination">
                  <FileText size={23} />
                  <p>
                    After creation, <strong>{name}</strong> will be mounted to{" "}
                    <strong>{props.mountExpertName}</strong>.
                  </p>
                </div>
              ) : null}
            </>
          ) : null}
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
        </div>

        <footer className="drawer-actions">
          <button
            className="secondary-button"
            type="button"
            disabled={saving}
            onClick={() => {
              if (step === "type") props.onClose();
              else setStep(step === "review" ? "configure" : "type");
            }}
          >
            {step === "type" ? "Cancel" : "Back"}
          </button>
          <button
            className="primary-button"
            type="button"
            disabled={saving}
            onClick={() => {
              if (step === "type") setStep("configure");
              else if (step === "configure") continueFromConfigure();
              else void submit();
            }}
          >
            {saving
              ? "Creating…"
              : step === "review"
                ? props.mountExpertName
                  ? "Create and mount"
                  : "Create store"
                : step === "configure"
                  ? "Continue to review"
                  : "Continue"}
          </button>
        </footer>
      </aside>
    </div>
  );
}

function ContextEntityCreatorDrawer(props: {
  readonly store: Extract<ContextStore, { type: "note" }>;
  readonly onClose: () => void;
  readonly onCreate: (storeId: string, entry: ContextNoteEntry) => Promise<ContextStore>;
}) {
  const [id, setId] = useState("");
  const [description, setDescription] = useState("");
  const [content, setContent] = useState("");
  const [trigger, setTrigger] = useState<ContextTrigger>("manual");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!id.trim() || !description.trim() || !content.trim()) {
      setError("ID, description, content, and loading behavior are required.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await props.onCreate(props.store.id, {
        id: id.trim(),
        description: description.trim(),
        content: content.trim(),
        trigger,
      });
      props.onClose();
    } catch (createError) {
      setSaving(false);
      setError(errorMessage(createError));
    }
  };

  return (
    <div className="drawer-layer" role="presentation">
      <button
        className="drawer-scrim"
        type="button"
        aria-label="Close add entity"
        onClick={props.onClose}
      />
      <aside className="store-creator-drawer" aria-labelledby="add-context-entity-heading">
        <header className="drawer-heading">
          <div>
            <h2 id="add-context-entity-heading">Add context entity</h2>
            <p>{props.store.name}</p>
          </div>
          <button type="button" aria-label="Close" onClick={props.onClose}>
            <X size={22} />
          </button>
        </header>
        <div className="drawer-body store-config-form">
          <label>
            Entity ID
            <input
              value={id}
              onChange={(event) => setId(event.target.value)}
              placeholder="review-rules"
              autoFocus
            />
            <small>
              Use lowercase letters, numbers, and hyphens. The ID becomes the JSON filename.
            </small>
          </label>
          <label>
            Description
            <input
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="When this context is relevant"
            />
          </label>
          <label>
            Content
            <textarea
              className="note-content-input"
              value={content}
              onChange={(event) => setContent(event.target.value)}
            />
          </label>
          <fieldset className="trigger-options">
            <legend>Loading behavior</legend>
            {(
              [
                ["always_on", "Load immediately", "Inject content into every run."],
                [
                  "model_decision",
                  "Model decides",
                  "Expose ID and description, then let the model load it.",
                ],
                ["manual", "On demand", "Load explicitly by context ID."],
              ] as const
            ).map(([value, label, help]) => (
              <label className={trigger === value ? "is-selected" : ""} key={value}>
                <input
                  type="radio"
                  name="entity-trigger"
                  checked={trigger === value}
                  onChange={() => setTrigger(value)}
                />
                <span>
                  <strong>{label}</strong>
                  <small>{help}</small>
                </span>
              </label>
            ))}
          </fieldset>
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
        <footer className="drawer-actions">
          <button
            className="secondary-button"
            type="button"
            onClick={props.onClose}
            disabled={saving}
          >
            Cancel
          </button>
          <button
            className="primary-button"
            type="button"
            onClick={() => void submit()}
            disabled={saving}
          >
            {saving ? "Adding…" : "Add entity"}
          </button>
        </footer>
      </aside>
    </div>
  );
}

export function ExpertContextMountDrawer(props: {
  readonly expertName: string;
  readonly stores: readonly ContextStore[];
  readonly mounts: readonly ExpertContextStoreMount[];
  readonly onClose: () => void;
  readonly onSave: (mounts: readonly ExpertContextStoreMount[]) => Promise<void>;
  readonly onCreateStore: (input: CreateContextStore) => Promise<ContextStore>;
  readonly onStoreCreated: (store: ContextStore) => void;
  readonly onPickFolder: () => Promise<string | undefined>;
}) {
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState<readonly ExpertContextStoreMount[]>(props.mounts);
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const filteredStores = props.stores.filter((store) =>
    `${store.name} ${store.description}`.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const toggleMount = (storeId: string) => {
    if (draft.some((mount) => mount.storeId === storeId)) {
      setDraft(
        draft
          .filter((mount) => mount.storeId !== storeId)
          .map((mount, priority) => ({ ...mount, priority })),
      );
    } else {
      setDraft([...draft, { storeId, enabled: true, priority: draft.length }]);
    }
  };

  if (creating) {
    return (
      <ContextStoreCreatorDrawer
        mountExpertName={props.expertName}
        onClose={() => setCreating(false)}
        onCreate={props.onCreateStore}
        onPickFolder={props.onPickFolder}
        onCreated={(store) => {
          props.onStoreCreated(store);
          setDraft([...draft, { storeId: store.id, enabled: true, priority: draft.length }]);
          setCreating(false);
        }}
      />
    );
  }

  return (
    <div className="drawer-layer" role="presentation">
      <button
        className="drawer-scrim"
        type="button"
        aria-label="Close context configuration"
        onClick={props.onClose}
      />
      <aside
        className="store-creator-drawer context-mount-drawer"
        aria-labelledby="mount-context-heading"
      >
        <header className="drawer-heading">
          <div>
            <h2 id="mount-context-heading">Add context</h2>
            <p>Choose what {props.expertName} can know at runtime.</p>
          </div>
          <button type="button" aria-label="Close" onClick={props.onClose}>
            <X size={22} />
          </button>
        </header>
        <div className="drawer-body">
          <label className="directory-search mount-search">
            <MagnifyingGlass size={18} />
            <span className="sr-only">Search stores</span>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search stores"
            />
          </label>
          <div className="mount-store-list">
            {filteredStores.map((store) => {
              const mount = draft.find((item) => item.storeId === store.id);
              const StoreIcon = store.type === "file" ? Folder : BookOpenText;
              return (
                <div
                  className={mount ? "mount-store-row is-selected" : "mount-store-row"}
                  key={store.id}
                >
                  <button
                    type="button"
                    className="mount-store-toggle"
                    onClick={() => toggleMount(store.id)}
                  >
                    <span className="store-icon">
                      <StoreIcon size={21} />
                    </span>
                    <span>
                      <strong>{store.name}</strong>
                      <small>{store.type === "file" ? "File store" : "Context note"}</small>
                    </span>
                    <span className="mount-checkbox" aria-label={mount ? "Mounted" : "Not mounted"}>
                      {mount ? <Check size={15} /> : null}
                    </span>
                  </button>
                  {mount ? (
                    <p className="mount-trigger-summary">
                      {store.type === "file"
                        ? "Loading behavior comes from each file's metadata. Files without metadata are manual."
                        : store.entries.length === 1
                          ? triggerLabel(store.entries[0]!.trigger)
                          : "Loading behavior is configured per note entry."}
                    </p>
                  ) : null}
                </div>
              );
            })}
            {filteredStores.length === 0 ? (
              <p className="mount-empty">No matching stores.</p>
            ) : null}
          </div>
          <button className="create-inline-store" type="button" onClick={() => setCreating(true)}>
            <Plus size={18} />
            <span>
              <strong>Create new store</strong>
              <small>Add a file store or context note without leaving this expert.</small>
            </span>
            <CaretRight size={17} />
          </button>
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
        <footer className="drawer-actions">
          <button
            className="secondary-button"
            type="button"
            onClick={props.onClose}
            disabled={saving}
          >
            Cancel
          </button>
          <button
            className="primary-button"
            type="button"
            disabled={saving}
            onClick={() => {
              setSaving(true);
              void props.onSave(draft).catch((saveError: unknown) => {
                setSaving(false);
                setError(errorMessage(saveError));
              });
            }}
          >
            {saving
              ? "Saving…"
              : `Save ${draft.length} mounted store${draft.length === 1 ? "" : "s"}`}
          </button>
        </footer>
      </aside>
    </div>
  );
}
