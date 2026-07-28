# Authoring in Handoff Beat

Use this guide when you are an OIDC-authenticated, nontechnical author preparing a bilingual change. The author surface is for **edit → preview → propose**. A human with the separate governed authority reviews and decides what may be approved, applied, published, or rolled back.

## 1. Sign in

Open the Handoff author surface and sign in through the configured OIDC provider. The server verifies the OIDC issuer, audience, JWKS signature, expiry, `not-before`, and allowed algorithm; a client cannot replace those checks ([server OIDC contract](../../packages/server/src/config.ts#L82-L102), [identity resolution](../../packages/api/src/auth.ts#L1-L18)). Use the identity and tenant provided by your host. Do not paste credentials into a proposal, browser field, or document.

After sign-in, confirm that the authoring page exposes both **English** and **Spanish** peers. Switching the language selector changes the UI language and preserves the same surface set; it is not a fallback mechanism ([locale renderer](../../packages/web/src/template.ts#L8-L27)).

## 2. Make the bilingual proposal

1. Enter or revise the English value.
2. Enter or revise the Spanish value for the same field.
3. For image blocks, provide required alternative text in both locales and, when needed, set crop and focal-point values.
4. For product-safe content, edit only the title and summary. Check the displayed price as context, but do not edit it.
5. Use only the block actions that the surface exposes for the approved section (for example, reorder, hide, or duplicate).

English and Spanish are peer content, not primary content plus an optional translation. Missing values are rejected rather than silently copied from the other language ([peer locale model rule](../../packages/web/src/model.ts#L28-L35)). The browser journey demonstrates filling both text and alt peers and updating safe product titles while asserting that no product-price input exists ([five-task journey](../../packages/web/e2e/handoff-beat.spec.ts#L37-L65)).

**Commerce boundary:** price, inventory, Stripe-coupled data, and other commerce fields are coordinator-gated and client-read-only. Do not add or attempt to change those values in an author proposal. Contact the commerce coordinator through your host's established process.

While you are still editing, **Undo last local edit** can reverse a pending local change. This is browser-local history; it is not a governed rollback and does not write canonical content ([local undo contract](../../packages/web/src/model.ts#L292-L305), [history control](../../packages/web/src/template.ts#L465-L495)).

## 3. Preview

Choose **Preview** after both locales and required image text are complete. The client validates the current snapshot and asks the API for a server-rendered preview. A successful response creates a `preview_ready` state and a preview revision token; it does not apply, publish, or write the host repository ([preview API seam](../../packages/web/src/model.ts#L384-L390), [preview dispatch](../../packages/web/src/model.ts#L1410-L1459)). Review both language peers and the safe commerce display in the preview.

If preview is blocked, read the error summary rather than guessing. A missing required field identifies the field and moves focus to the summary; fix the indicated English or Spanish value, then preview again ([failure test](../../packages/web/e2e/handoff-beat.spec.ts#L191-L199)). Stable client error codes are listed in [`STORE_ERROR_CODES`](../../packages/web/src/model.ts#L111-L133), including `E_MISSING_ALT`, `E_NOT_PREVIEW_READY`, `E_API_ERROR`, and `E_NOT_REVERSIBLE`.

## 4. Request human review

When the preview is correct, choose **Propose for review** and confirm the request. This sends the bilingual snapshot as a proposal and creates a candidate revision. It does not approve or publish the change; the localized confirmation states that distinction directly ([proposal labels and confirmation](../../packages/i18n/src/index.ts#L104-L120), [proposal dispatch](../../packages/web/src/model.ts#L1460-L1500)). Share the proposal/revision context with the human reviewer using your host's normal review channel.

After proposing, the local pending-edits layer is committed. Do not use local undo as a substitute for a governed correction; make a new proposal or ask the reviewer/coordinator what correction is required.

## 5. Know the author boundary

The author surface must not be used to **approve, publish, apply, reconcile, or roll back**. Do not try to call these actions from a browser console, a client-only script, a service credential, or an MCP path. Approval, publication, canonical writes, deploy reconciliation, and governed rollback require the separate authority workflow and human checks ([authority API rules](../../packages/api/src/index.ts#L17-L27), [human-only enforcement](../../packages/api/src/auth.ts#L197-L225)).

A displayed `approved`, `canonical_written`, `deploy_pending`, or `live` state is status, not an author capability. If a rollback is required, ask the authorized human/operator. In this contract rollback ends at `canonical_written`; asynchronous deployment reconciliation follows. That is intentionally different from undoing an unsubmitted local edit.

## 6. Use the accessible controls

Handoff Beat is **“neurodivergent-accessible by design”**. This is the exact V1 wording; it is not external validation. The current limitation is **“External validation is planned for v1.1.”** ([catalog wording](../../packages/i18n/src/index.ts#L160-L173)).
The Docker runtime is unverified; this authoring journey and its preview do not establish a live container deployment.

Use the skip link, native labelled controls, keyboard navigation, focus-visible indicators, and the low-distraction or reduced-motion preferences when useful. When an action succeeds, a status announcement confirms it. When an action fails, an assertive error region and error-summary focus provide the next place to work; the app does not silently pretend the command succeeded ([app accessibility behavior](../../packages/web/src/app.ts#L14-L24), [E2E accessibility checks](../../packages/web/e2e/handoff-beat.spec.ts#L89-L99)).

The EN and ES surfaces are peers: the same authoring regions remain present in either locale, and missing translations fail closed instead of falling back to English ([i18n peer contract](../../packages/i18n/src/index.ts#L1-L12)).

## Quick boundary checklist

- [ ] I signed in through the configured OIDC identity provider.
- [ ] I completed both English and Spanish values.
- [ ] I supplied both peer alt texts where an image requires them.
- [ ] I changed only safe content; commerce fields remain read-only and coordinator-gated.
- [ ] I reviewed the server-rendered preview.
- [ ] I proposed the draft for human review.
- [ ] I did **not** approve, publish, apply, reconcile, or roll back.
