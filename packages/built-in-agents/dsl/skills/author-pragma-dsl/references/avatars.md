# Expert avatar personas

Every built-in Expert avatar has a stable fictional persona. The image ID is the portable value
stored in `metadata.avatarId`; name, gender, and personality are selection metadata only.

| `avatarId`                | Name  | Gender    | Personality                        |
| ------------------------- | ----- | --------- | ---------------------------------- |
| `pragma.avatar.expert.01` | Zara  | woman     | analytical, calm, perceptive       |
| `pragma.avatar.expert.02` | Tom   | man       | curious, optimistic, collaborative |
| `pragma.avatar.expert.03` | Kai   | nonbinary | decisive, bold, pragmatic          |
| `pragma.avatar.expert.04` | Mina  | woman     | patient, empathetic, thoughtful    |
| `pragma.avatar.expert.05` | Leo   | man       | creative, strategic, confident     |
| `pragma.avatar.expert.06` | Noah  | man       | energetic, adaptable, sociable     |
| `pragma.avatar.expert.07` | Ada   | woman     | meticulous, analytical, focused    |
| `pragma.avatar.expert.08` | Owen  | man       | pragmatic, calm, reliable          |
| `pragma.avatar.expert.09` | Eli   | nonbinary | curious, collaborative, inventive  |
| `pragma.avatar.expert.10` | Maya  | woman     | diplomatic, empathetic, strategic  |
| `pragma.avatar.expert.11` | Finn  | nonbinary | energetic, optimistic, adaptable   |
| `pragma.avatar.expert.12` | Ruby  | woman     | bold, creative, independent        |
| `pragma.avatar.expert.13` | Hugo  | man       | analytical, focused, confident     |
| `pragma.avatar.expert.14` | Noor  | woman     | patient, thoughtful, diplomatic    |
| `pragma.avatar.expert.15` | Jamie | nonbinary | adaptable, collaborative, curious  |
| `pragma.avatar.expert.16` | Skye  | woman     | decisive, bold, energetic          |
| `pragma.avatar.expert.17` | Iris  | woman     | strategic, meticulous, calm        |
| `pragma.avatar.expert.18` | Felix | man       | sociable, optimistic, persuasive   |
| `pragma.avatar.expert.19` | Cora  | woman     | creative, perceptive, confident    |
| `pragma.avatar.expert.20` | Theo  | man       | pragmatic, reliable, collaborative |
| `pragma.avatar.expert.21` | Nia   | woman     | calm, empathetic, focused          |
| `pragma.avatar.expert.22` | Evan  | man       | analytical, inventive, meticulous  |
| `pragma.avatar.expert.23` | Luna  | woman     | perceptive, creative, empathetic   |
| `pragma.avatar.expert.24` | Alex  | nonbinary | independent, adaptable, curious    |
| `pragma.avatar.expert.25` | Vera  | woman     | thoughtful, strategic, reliable    |
| `pragma.avatar.expert.26` | Sam   | man       | energetic, pragmatic, optimistic   |
| `pragma.avatar.expert.27` | Cleo  | woman     | inventive, decisive, sociable      |

Use the current `list_expert_options.avatars` result as the runtime source of truth. Recommend a
persona by matching its traits to the Expert's intended working style. If several personas fit or
the choice is mainly aesthetic, present a short relevant subset and let the user choose. Never infer
capabilities, permissions, or actual behavior from a persona. Preserve the current `avatarId` when
editing unless the user asks to change it.
