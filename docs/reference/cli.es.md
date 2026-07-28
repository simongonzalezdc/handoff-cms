# Referencia de la CLI

La CLI es una proyección fina sobre la API HTTP autoritativa. Nunca modifica directamente el host: cada operación se convierte en una solicitud a la API y el host sigue siendo la fuente canónica.

## Comandos (exactamente nueve)

| Comando | Alias | Privilegio |
| --- | --- | --- |
| `help` | `--help` | no |
| `health` | — | no |
| `proposal get <id>` | `proposals get <id>` | no |
| `proposal create` | `proposals create` | no |
| `proposal approve <id>` | `proposals approve <id>` | privilegiado |
| `proposal publish <id>` | `proposals publish <id>` | privilegiado |
| `proposal rollback <id>` | `proposals rollback <id>` | privilegiado |
| `proposal deploy status <id>` | `proposals deploy status <id>` | no |
| `proposal deploy reconcile <id>` | `proposals deploy reconcile <id>` | privilegiado |

Inventario fuente: `COMMANDS` y `PRIVILEGED_COMMANDS` en [`packages/cli/src/index.ts:385-403`](../../packages/cli/src/index.ts#L385-L403).

Los cuatro comandos privilegiados son aprobar, publicar, revertir y reconciliar el despliegue. La ejecución privilegiada exige una **sesión interactiva delegada a una persona, recién obtenida**. Los tokens de entorno, credenciales de servicio, identidades MCP y sesiones caducadas o antiguas no pueden autorizar estos comandos. El flujo de dispositivo abre la URI de verificación configurada y valida tenant, audiencia y caducidad antes de enviar la solicitud; la seam de navegador predeterminada rechaza la autorización interactiva salvo que la aplicación inyecte una seam aprobada.

`proposal create` acepta un objeto JSON desde `--file <ruta>` o `--data '<json>'`. Los archivos se leen localmente como JSON UTF-8; los directorios, archivos inexistentes y JSON mal formado se rechazan. Cuando ambas opciones están presentes, `--file` tiene precedencia y `--data` se ignora; usa solo una para evitar una intención operativa ambigua. La CLI exige un objeto `proposal` de nivel superior y deriva el método HTTP y la ruta exclusivamente del comando; la API valida la forma completa del cuerpo. Usa `--expect-version` para concurrencia optimista y una clave de idempotencia cuando la API la exija. La reconciliación del despliegue solo acepta un resultado booleano de éxito.

## Errores y estado de salida

La CLI expone exactamente ocho valores `CliErrorCode`: `usage`, `credential_forbidden`, `network`, `problem`, `unexpected`, `conflict`, `not_found` y `validation` ([fuente](../../packages/cli/src/index.ts#L179-L188)). Se asignan respectivamente a las salidas 64, 77, 3, 2, 1, 4, 2 y 65 en [`cliErrorToExitCode`](../../packages/cli/src/index.ts#L1137-L1165). Las respuestas de problema RFC 9457 conservan `type`, `title`, `status`, `detail`, `instance`, `code`, `locale` (`en` o `es`) y sus extensiones. Los códigos de problema de la API asignan entrada inválida a 65, autoridad prohibida o identidad inválida a 77, no encontrado a 2, conflictos de concurrencia/idempotencia a 4 y fallo de conexión a 3; los códigos `E_*` desconocidos salen con 2 y otros problemas desconocidos con 1 ([`exitCodeForProblem`](../../packages/cli/src/index.ts#L1071-L1135)).

## Configuración y salida

La URL base, tenant, locale, modo de salida, versión esperada y credenciales se resuelven mediante flags, entorno y configuración explícita. La salida humana se localiza en inglés o español; la salida de máquina conserva JSON estructurado. `--locale` sobrescribe `CMS_LOCALE`; si faltan ambos, la CLI usa explícitamente `en`. Los valores fuera de `en` y `es` fallan con un error de uso en vez de sustituir silenciosamente el otro locale par ([fuente](../../packages/cli/src/index.ts#L663-L671)).

La CLI no aprueba, publica ni revierte mediante una identidad de agente. Una persona realiza esas transiciones privilegiadas; puede producirse una reversión después del beat `canonical_written`, mientras el estado terminal de la propuesta es `rolled_back`.
