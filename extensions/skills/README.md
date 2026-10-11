# Skills

Load `@leitwerk-dev/skills` to make the bundled skills discoverable on every LLM
turn. Pi loads a skill's instructions when the agent selects it.

The Skills page lists extension-provided skills as **Bundled**, with their
instructions and owning extension. They are automatically available to every AI
step and do not need installation or selection in a launcher. Update or remove
the owning extension to change them.

`leitwerk.pi.resources.skills` in `package.json` lists the skill directory roots.
Add plain `<name>/SKILL.md` directories under a listed root, with `name` and
`description` in their YAML frontmatter. Supporting files stay beside the skill.

The initial skill, `doc-writing`, contains the upstream `WRITING.md` guidance.
Keep its body aligned when that writing guide changes.
