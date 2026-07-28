# Arquitectura

Handoff CMS es un workspace pnpm organizado como un grafo de dependencias unidireccional. El repositorio anfitrión sigue siendo la fuente canónica; el sistema valida propuestas, registra decisiones humanas, escribe bytes canónicos y coordina proyecciones.

## DAG de dependencias

```text
@cms/core  ───────────────► @cms/storage
     │                            │
     └──────────────► @cms/api ◄──┘
                            │
             ┌──────────────┼──────────────┐
             ▼              ▼              ▼
          @cms/cli       @cms/mcp     @cms/server
             │              │              │
             └────── HTTP/handle ──────────┘

@cms/adapter-sdk ─► adaptadores anfitrión
@cms/audit       ─► integración de auditoría de la API
```

`@cms/core` posee los tipos de dominio, invariantes, política y máquina de estados de propuestas. `@cms/storage` persiste los registros y migraciones del núcleo. `@cms/api` es el transporte Hono/OpenAPI autoritativo sobre esos paquetes; no reimplementa política ni transiciones. CLI y MCP son clientes/proyecciones de esa API (o de su interfaz `handle`), nunca superficies de autoridad alternativas. Server aporta configuración/autenticación de runtime y monta la API. Los contratos de Adapter SDK los implementan adaptadores del anfitrión; resuelven rutas y escriben en el anfitrión, pero no poseen autoridad de gobernanza. Audit proporciona estructuras canónicas y firmadas para eventos.

## Límites de transporte y autoridad

Todas las mutaciones web, CLI y MCP entran por `@cms/api`. Cada escritura exige ámbito de tenant e idempotencia; aprobar, publicar, revertir y reconciliar exigen además control optimista `If-Match`. La API autentica y resuelve al actor antes de invocar la única fachada de autorización. Las decisiones de política y de máquina de estados permanecen en `@cms/core`; la persistencia permanece en `@cms/storage`.

El `canonical_source` del anfitrión es el único destino de escritura. Los `derived_artifacts` son proyecciones servidas y nunca se escriben directamente. `reconcile` es de solo lectura y debe observar el estado canónico actual antes de `apply`; `apply` solo escribe canónico. La regeneración usa el contrato explícito `alias_symlink`. Un recibo de despliegue informa únicamente de propagación: `canonical_written` y `live`/`live_propagated` son estados distintos. Un recibo fallido deja la propuesta en `canonical_written`; no inventa silenciosamente un estado intermedio.

Los adaptadores son superficies de escritura, no de autoridad. Su capacidad de despliegue es consultiva y coordinada; ningún adaptador, agente, servicio o ruta MCP puede aprobar, publicar o revertir. Los campos de comercio siguen coordinados y son de solo lectura para el cliente. Ningún transporte recurre silenciosamente a otra fuente, y los valores `en` o `es` ausentes se rechazan en vez de aplicar valores predeterminados.

## Evidencia

- `packages/core/src/domain.ts`, `policy.ts`, `state-machine.ts`
- `packages/storage/src/index.ts`, `migrations/0001_governance.sql`
- `packages/api/src/index.ts`, `auth.ts`, `openapi.ts`
- `packages/cli/src/index.ts`; `packages/mcp/src/server.ts`; `packages/server/src/index.ts`
- `packages/adapter-sdk/src/index.ts`; `packages/adapter-cerafica/src/index.ts`
- `packages/audit/src/index.ts`
