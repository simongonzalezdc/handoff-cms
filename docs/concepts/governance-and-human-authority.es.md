# Gobernanza y autoridad humana

La gobernanza es un ciclo explícito: **proponer → validar → aprobar → publicar → canonical_written → (propagación viva opcional) → revertir**. Una propuesta es una intención; la revisión aprobada es inmutable. El anfitrión sigue siendo canónico y cada transición se comprueba contra política y versión, es idempotente y queda auditada.

## Ciclo controlado por humanos

1. **Proponer.** Una persona autora o una automatización envía una propuesta localizada (`en` y `es`). La API la valida y registra identidad y hash del contenido.
2. **Aprobar.** Se exige un evento de autorización humana vigente. La autoaprobación se representa explícitamente (`selfApproved`) y solo se permite cuando la política vigente lo admite; nunca se infiere.
3. **Publicar.** Una transición autorizada por una persona escribe la revisión aprobada en el `canonical_source` del anfitrión. La API devuelve `canonical_written`; no afirma que un sitio remoto esté activo.
4. **Propagar/reconciliar.** Un adaptador con alcance limitado puede informar recibos de despliegue. `live`/`live_propagated` es otro momento. La propagación fallida se registra como fallida y la propuesta permanece en `canonical_written` (fallo cerrado).
5. **Revertir.** Una acción de autorización humana vigente puede revertir según la política actual y controles optimistas de versión. No reproduce credenciales ni suplanta a la persona que aprobó originalmente. La auditoría conserva la genealogía de la reversión.

## Sesiones humanas delegadas

Una identidad humana delegada sigue siendo humana: lleva `delegatorId`, `delegatedAt` y `delegatedUntil`, y la API vuelve a comprobar que la sesión esté vigente. La CLI obtiene credenciales privilegiadas solo mediante un flujo interactivo y reciente de navegador/dispositivo (`delegated_human_fresh_interactive`). Credenciales estáticas de entorno, servicio, agente o MCP fallan de forma cerrada. La delegación se registra en los datos de propuesta, aprobación y auditoría; no oculta a la persona responsable.

## Ocho invariantes aprobados (lista de comprobación literal)

1. `canonical_source` es la única referencia canónica del anfitrión.
2. `derived_artifacts` es una lista cerrada y nunca un destino de escritura directa.
3. `regeneration_contract` es explícito; v1 solo reconoce `alias_symlink`.
4. Los adaptadores deben resolver un binding único y no ambiguo; se rechazan bindings ambiguos, que escapan, autorreferenciales o vacíos.
5. Reconcile es de solo lectura y apply solo canónico, después de reconciliar el estado actual.
6. Aprobar, publicar y revertir son transiciones del sistema con autoridad humana, nunca autoridad del adaptador.
7. Los valores localizados requieren `en` y `es`; los idiomas ausentes se rechazan, nunca se completan silenciosamente.
8. La escritura canónica y la propagación viva son estados separados; la reversión termina en `canonical_written`.

## Prohibición de transiciones privilegiadas

La API rechaza identidades de servicio y las identidades con capacidad `mcp` antes de evaluar la política para aprobar, publicar y revertir (`E_SERVICE_APPROVAL_FORBIDDEN`, `E_MCP_APPROVAL_FORBIDDEN`). Agentes y herramientas MCP pueden proponer o informar recibos de despliegue acotados cuando se permita; no pueden fabricar aprobación humana, autoridad de publicación ni autoridad de reversión. No se permite fallback silencioso ni suplantación.

## Evidencia

- `packages/api/src/auth.ts`, `index.ts`, `openapi.ts`
- `packages/core/src/domain.ts`, `policy.ts`, `state-machine.ts`
- `packages/cli/src/index.ts`
- `packages/adapter-sdk/src/index.ts`, `packages/adapter-cerafica/src/index.ts`
- `packages/audit/src/index.ts`
