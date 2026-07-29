# Handoff CMS

Open-source agentic client-handoff CMS: agents propose content changes; humans approve publish/apply/rollback. Bilingual EN/ES, adapters, audit, CLI, API, and MCP.

**Who it is for:** agencies and self-hosters who need governed handoff between teams and host websites — without making agents the publisher of record.

**What you get:** a self-hostable governance monorepo. The **host** stays canonical for content bytes; the CMS owns proposals, approvals, permissions, audit, preview, and rollback.

## Quick start

```bash
git clone https://github.com/simongonzalezdc/handoff-cms.git
cd handoff-cms
# bring-up: Postgres + MinIO + server — see docs/how-to/self-host.md
```

Hard rule: service and MCP identities never approve or publish. Humans only.

## Paths by audience

| You are… | Start here |
|----------|------------|
| Client author (Handoff Beat) | [docs/how-to/authoring.md](docs/how-to/authoring.md) |
| Agency operator | [docs/how-to/self-host.md](docs/how-to/self-host.md), [operate](docs/how-to/operate.md) |
| Self-hoster / hardener | [self-host](docs/how-to/self-host.md), [hardening](docs/security/hardening.md) |
| Adapter builder | `@cms/adapter-sdk` docs under `docs/` |

## Docs

- Concepts: [handoff-beat](docs/concepts/handoff-beat.md)
- Configure: [docs/how-to/configure.md](docs/how-to/configure.md)
- Security: [threat model](docs/security/threat-model.md)
- Error codes: [docs/reference/error-codes.md](docs/reference/error-codes.md)

## License

Apache-2.0. See [LICENSE](LICENSE).
