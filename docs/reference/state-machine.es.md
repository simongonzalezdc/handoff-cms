# Máquina de estados de gobernanza

> **Audiencia:** integradores, operadores y personas que construyen
> adaptadores que necesitan el contrato cerrado del ciclo de vida de
> las propuestas. Esta página está orientada a la información
> (referencia de Diátaxis): refleja `packages/core/src/state-machine.ts`
> línea por línea y explica la proyección al alfabeto de
> almacenamiento definido por la restricción `CHECK` de Postgres. La
> guía procedural del ciclo de vida vive en
> [`docs/concepts/handoff-beat.es.md`](../concepts/handoff-beat.es.md).

> [English version](state-machine.md) · El inglés y el español son
> idiomas pares. Ambos hermanos se publican en el mismo *pull
> request* (regla de desfase cero). Véase
> [`../README.es.md#desfase-cero-enes-en-el-mismo-pr`](../README.es.md#desfase-cero-enes-en-el-mismo-pr).

## Qué es la máquina de estados

La máquina de estados en `@cms/core` es una función de transición
pura y determinista sobre el ciclo de vida de las propuestas. Tiene
exactamente dieciocho estados, once acciones y un estado terminal.
La máquina de estados nunca realiza E/S, nunca consulta el
almacenamiento y nunca resuelve la autoridad del actor; esas
verificaciones viven en el servicio de aplicación que rodea a
`transition()`.

El ciclo de vida cubre autoría, validación, vista previa, aprobación,
aplicación (escritura canónica), propagación, paso a producción,
reconciliación y una reversión de una sola acción desde cualquier
rama de fallo o desde los estados posteriores a la publicación.

## Los dieciocho estados

Fuente: `packages/core/src/state-machine.ts:26-44`
(tipo `ContentState`) y `:46-65` (*array* `ALL_STATES`). El conjunto
es **cerrado**: añadir un estado requiere actualizar tanto el alias
de tipo como el *array* en tiempo de ejecución.

| # | Estado | Clase |
| --- | --- | --- |
| 1 | `draft` | Inicial |
| 2 | `proposed` | Inicial |
| 3 | `validated` | Exitoso |
| 4 | `validation_failed` | Fallo |
| 5 | `previewing` | Exitoso |
| 6 | `preview_failed` | Fallo |
| 7 | `approved` | Exitoso |
| 8 | `approval_revoked` | Fallo |
| 9 | `applying` | Exitoso |
| 10 | `apply_failed` | Fallo |
| 11 | `canonical_written` | Exitoso (momento de escritura) |
| 12 | `write_failed` | Fallo |
| 13 | `propagating` | Exitoso |
| 14 | `propagate_failed` | Fallo |
| 15 | `live` | Exitoso |
| 16 | `reconcile_failed` | Fallo |
| 17 | `reconciled` | Exitoso (terminal-pero-no-final) |
| 18 | `rolled_back` | Terminal |

Cuenta por clases: 10 estados que no son de fallo ni terminales (incluido el momento de escritura en
`canonical_written` y el estado exitoso posterior a la
publicación), 7 ramas de fallo y 1 terminal. `draft` es el único estado
inicial; `proposed` se alcanza mediante la transición `submit`.
`rolled_back` es el único estado terminal.

### Estado terminal — `rolled_back`

Fuente: `packages/core/src/state-machine.ts:67-69`.

```ts
export const TERMINAL_STATES: readonly ContentState[] = [
  'rolled_back',
] as const;
```

`rolled_back` es el único estado desde el que no se define ninguna
transición posterior. `isTerminalState`
(`packages/core/src/state-machine.ts:204-206`) devuelve `true`
exclusivamente para `rolled_back`. Tras la reversión, la propuesta
es definitiva; los intentos posteriores de actuar sobre ella
devuelven `E_INVALID_TRANSITION`.

### Estados de fallo (siete)

Fuente: `packages/core/src/state-machine.ts:71-79`.

```ts
export const FAILURE_STATES: readonly ContentState[] = [
  'validation_failed',
  'preview_failed',
  'approval_revoked',
  'apply_failed',
  'write_failed',
  'propagate_failed',
  'reconcile_failed',
] as const;
```

Cada estado de fallo es alcanzable desde exactamente un estado
exitoso mediante la misma acción que, en caso contrario, haría
avanzar el ciclo de vida. El fallo nunca es silencioso ni implícito:
una acción `validate` lleva de `validated` a `validation_failed`,
una acción `canonical_write` lleva de `canonical_written` a
`write_failed`, y así sucesivamente.

## Camino exitoso

Fuente: `packages/core/src/state-machine.ts:5-12` y `:100-128`
(`TRANSITIONS`).

```text
draft -> proposed -> validated -> previewing -> approved
      -> applying -> canonical_written -> propagating -> live -> reconciled
```

Nueve transiciones secuenciales. Cada transición es una acción:

| Paso | Desde | Acción | Hacia |
| --- | --- | --- | --- |
| 1 | `draft` | `submit` | `proposed` |
| 2 | `proposed` | `validate` | `validated` |
| 3 | `validated` | `preview` | `previewing` |
| 4 | `previewing` | `approve` | `approved` |
| 5 | `approved` | `apply` | `applying` |
| 6 | `applying` | `canonical_write` | `canonical_written` |
| 7 | `canonical_written` | `propagate` | `propagating` |
| 8 | `propagating` | `go_live` | `live` |
| 9 | `live` | `reconcile` | `reconciled` |

`reconciled` es el estado estable posterior a la publicación. Desde
`reconciled` las transiciones permitidas son `reconcile_fail` (de
vuelta a la rama de fallo) o `rollback` (terminal `rolled_back`).

## Caminos de fallo

Cada estado exitoso desde el paso 3 en adelante tiene un estado de
fallo del mismo nombre al que llega la misma acción cuando la
operación subyacente no tiene éxito. El estado de fallo se llama
`<fase>_failed` (o `approval_revoked` para la rama de aprobación,
que es una revocación explícita en lugar de un fallo técnico). La
tabla de transición es:

| Paso | Desde | Acción | Destino del fallo |
| --- | --- | --- | --- |
| 3 | `validated` | `validate` | `validation_failed` |
| 4 | `previewing` | `preview` | `preview_failed` |
| 5 | `approved` | `approve` | `approval_revoked` |
| 6 | `applying` | `apply` | `apply_failed` |
| 7 | `canonical_written` | `canonical_write` | `write_failed` |
| 8 | `propagating` | `propagate` | `propagate_failed` |
| 9 | `live` | `reconcile_fail` | `reconcile_failed` |
| 9b | `reconciled` | `reconcile_fail` | `reconcile_failed` |

No hay fallos implícitos. Si la acción no aparece listada para el
estado actual, `transition()` lanza `InvalidTransitionError` y
devuelve `E_INVALID_TRANSITION`.

## Reversión de una sola acción

Fuente: `packages/core/src/state-machine.ts:18-21`
(racional), `:119-127` (transiciones).

```text
validation_failed   ──rollback──► rolled_back
preview_failed      ──rollback──► rolled_back
approval_revoked    ──rollback──► rolled_back
apply_failed        ──rollback──► rolled_back
write_failed        ──rollback──► rolled_back
propagate_failed    ──rollback──► rolled_back
reconcile_failed    ──rollback──► rolled_back
live                ──rollback──► rolled_back
reconciled          ──rollback──► rolled_back
```

Una acción `rollback` está permitida desde cualquier rama de fallo y
desde cualquiera de los estados posteriores a la publicación. La
transición es un único movimiento de una acción al estado terminal
`rolled_back`. La focalización de revisión, el rechazo por base
obsoleta y la verificación de la ventana de reversión
(`E_ROLLBACK_WINDOW_EXPIRED`) los valida el servicio de aplicación
antes de esta transición pura; la máquina de estados en sí solo
comprueba que el estado actual permita `rollback`.

### Precisión entre el momento de escritura y la terminal `rolled_back`

El estado terminal de la propuesta es `rolled_back`. El momento de
escritura en `canonical_written` **no** es un estado terminal: es el
momento de escritura canónica desde el que continúa la propagación.
La confusión entre ambos es el origen de la única imprecisión
documentada:

- Tras un `canonical_write` exitoso, el estado es
  `canonical_written` y la propuesta no es definitiva. El resto del
  ciclo de vida (`propagate`, `go_live`, `reconcile`) se ejecuta a
  partir de ahí.
- Tras `rollback`, el estado es `rolled_back` y la propuesta es
  definitiva. La máquina de estados no permite ninguna acción
  posterior.

Una propuesta cuyo estado terminal de propuesta es `rolled_back`
(leído de `ProposalState` tras la proyección de almacenamiento) se
reporta como revertida; una propuesta cuyo último estado del núcleo
fue `canonical_written` se reporta como habiendo completado el
momento de escritura canónica. Los dos estados son distintos y
nunca se confunden.

## Vocabulario de acciones (once)

Fuente: `packages/core/src/state-machine.ts:81-92`.

| Acción | Usada desde |
| --- | --- |
| `submit` | `draft` |
| `validate` | `proposed`, `validated` |
| `preview` | `validated`, `previewing` |
| `approve` | `previewing`, `approved` |
| `apply` | `approved`, `applying` |
| `canonical_write` | `applying`, `canonical_written` |
| `propagate` | `canonical_written`, `propagating` |
| `go_live` | `propagating` |
| `reconcile` | `live` |
| `reconcile_fail` | `live`, `reconciled` |
| `rollback` | cualquier rama de fallo, `live`, `reconciled` |

`allowedActions(state)` (`packages/core/src/state-machine.ts:212-214`)
devuelve las acciones permitidas desde el estado dado: útil para
superficies de UI y para la representación de auditoría.

## Proyección núcleo ↔ almacenamiento

El alfabeto de almacenamiento es el subconjunto (y el destino de
proyección) del ciclo de vida del núcleo. El esquema de Postgres
aplica el alfabeto de almacenamiento mediante restricciones `CHECK`;
cada fila de propuesta persistida transporta exactamente un
`ProposalState`.

Fuente: `packages/core/src/state-machine.ts:228-244` (`ProposalState`).

| Estado del núcleo | Estado de almacenamiento (`ProposalState`) |
| --- | --- |
| `draft` | `draft` |
| `proposed` | `proposed` |
| `validated` | `validated` |
| `previewing` | `previewing` |
| `approved` | `approved` |
| `applying` | `applying` |
| `canonical_written` | `canonical_written` |
| `propagating` | `propagating` |
| `live` | `live` |
| `reconciled` | `reconciled` |
| `validation_failed` | `refused` |
| `preview_failed` | `refused` |
| `approval_revoked` | `rolled_back` |
| `apply_failed` | `apply_failed` |
| `write_failed` | `apply_failed` |
| `propagate_failed` | `deploy_failed` |
| `reconcile_failed` | `reconcile_pending` |
| `rolled_back` | `rolled_back` |

La proyección hacia adelante
(`mapContentStateToProposalState`,
`packages/core/src/state-machine.ts:301-303`) es total sobre
`ContentState`. La proyección inversa
(`mapProposalStateToContentState`,
`packages/core/src/state-machine.ts:311-313`) es total sobre
`ProposalState`; las filas de almacenamiento fuera del alfabeto de
almacenamiento fallan cerradas dentro del decodificador de
`@cms/storage`.

Los estados de fallo del núcleo que la restricción `CHECK` del
esquema no permite se colapsan sobre el estado de almacenamiento
más cercano semánticamente equivalente. La fila de auditoría
transporta el estado original del núcleo en el *payload* del evento,
de modo que la proyección es recuperable para la interfaz de
diagnóstico y de operaciones.

## Por qué este contrato es cerrado

La máquina de estados es la única fuente de verdad para "¿en qué
estado está esta propuesta?". La CLI, el MCP, el servidor, la web y
las superficies de adaptadores derivan su estado observable a partir
de `ContentState` y la proyección de almacenamiento. Un estado nuevo
es un cambio de contrato: cada consumidor y cada mensaje
localizado deben publicarse en el mismo *pull request*.

El contrato es también el único lugar donde se producen
`E_INVALID_TRANSITION` y `E_ROLLBACK_WINDOW_EXPIRED`. Ambos códigos de error forman parte de la unión Núcleo; consulta el [catálogo de códigos de error](error-codes.es.md) para la enumeración completa.
