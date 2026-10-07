/**
 * `dsh-session-delete` browser half.
 *
 * Adds one destructive action to the sidebar's Session rows — a `删除会话` row
 * in the row's "..." menu and a trash button among the row's hover actions —
 * and calls the Host half's route to remove that Conversation permanently.
 *
 * The half is a Module Loader package (`factory(require)`), so it needs no
 * build step: `react`, `react/jsx-runtime`, and the shared primitives resolve
 * through the loader's `require`.
 *
 * Conflict discipline:
 *
 *   - both contributions are registered through the **declared seats**
 *     `sidebar.workspaces.session.menu.item`, `sidebar.workspaces.session.row
 *     .action`, and `shell.overlay` — no DOM patching, no React-fiber reading,
 *     and no assumption about the row component's props;
 *   - the slot ids are namespaced (`session-delete.menu`, `session-delete.row`,
 *     `session-delete.confirm`) and never reuse a shipped id, so nothing
 *     existing is shadowed;
 *   - the Host is reached over this plugin's own `/api2/dsh-session-delete`
 *     route, so no existing route, service, or store is touched.
 *
 * @module dsh-session-delete/client
 */

window.__ModuleLoader__.load({
	id: 'dsh-session-delete',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

		const react = require('react');
		const primitives = require('@deepseek-ai/dsh-client-ui-primitives');

		/** Locale namespace of this plugin's own words. */
		const NS = 'dsh-session-delete';

		/** Host route the delete action calls. */
		const DELETE_ROUTE = '/api2/dsh-session-delete/delete';

		/** Host route that describes what a delete would destroy. */
		const INSPECT_ROUTE = '/api2/dsh-session-delete/inspect';

		/** Stable identity of the row action's stylesheet, for idempotent injection. */
		const STYLE_TAG_ID = `${NS}/row-action.css`;

		/** Class on the hover action's own button. */
		const ROW_BUTTON_CLASS = 'dshSessionDelete_rowButton';

		const CSS = [
			`.${ROW_BUTTON_CLASS}{align-items:center;justify-content:center;display:inline-flex;`,
			'width:22px;height:22px;padding:0;border:none;background:transparent;cursor:pointer;flex:none;',
			'border-radius:var(--dsw-radius-sm,6px);color:var(--dsw-alias-label-secondary,currentColor)}',
			`.${ROW_BUTTON_CLASS}:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16));`,
			'color:var(--dsw-alias-label-primary,currentColor)}',
			`.${ROW_BUTTON_CLASS}:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:1px}`,
		].join('');

		const zh = {
			'menu.delete': '删除会话',
			'confirm.title': '永久删除会话',
			'confirm.desc': '将永久删除「{title}」：会话日志、投影缓存与工作区记账记录都会一并清除，且无法恢复。这不是「归档会话」。按内容寻址的附件对象可能被其他会话共享，因此不会删除。',
			'confirm.size': '磁盘占用约 {size}。',
			'confirm.missing': '磁盘上已找不到该会话的数据，确认后只会把这一行从列表中移除。',
			'confirm.ack': '我明白该会话及其磁盘数据将被永久删除，无法恢复。',
			'confirm.action': '永久删除',
			'confirm.pending': '正在删除…',
			'confirm.failed': '删除失败',
			'done.title': '已删除',
			'done.desc': '该会话已从列表移除，数据被移到废纸篓：{path}。需要的话可以从废纸篓里把它取回来。',
			'done.missing': '磁盘上已没有该会话的数据，列表里的那一行也已移除。',
			'confirm.running': '该会话正在运行一个回合，现在无法删除。请先停止它，稍后再试。',
			'cancel': '取消',
			'close': '关闭',
		};

		const en = {
			'menu.delete': 'Delete conversation',
			'confirm.title': 'Delete this conversation permanently',
			'confirm.desc': 'This permanently deletes “{title}”: its session log, projection cache, and workspace accounting records are all removed, with no way back. It is not the same as Archive. Content-addressed attachment objects may be shared with other conversations, so they are not deleted.',
			'confirm.size': 'About {size} on disk.',
			'confirm.missing': 'No data for this conversation is left on disk; confirming only removes its row from the list.',
			'confirm.ack': 'I understand this conversation and its on-disk data are permanently deleted and cannot be recovered.',
			'confirm.action': 'Delete permanently',
			'confirm.pending': 'Deleting…',
			'confirm.failed': 'Delete failed',
			'done.title': 'Deleted',
			'done.desc': 'This conversation is out of the list, and its data is in the Trash: {path}. Pull it back out of the Trash if you need it.',
			'done.missing': 'No data for this conversation was left on disk; its row is gone from the list.',
			'confirm.running': 'This conversation is running a turn and cannot be deleted right now. Stop it and try again.',
			'cancel': 'Cancel',
			'close': 'Close',
		};

		//#region the pending-delete store
		/**
		 * One tiny external store shared by the three contributions. A module
		 * -level store keeps the dialog out of the menu's own mount lifetime:
		 * selecting the row closes the menu, and the confirmation still renders
		 * from the shell overlay.
		 * @param initial - the initial value.
		 * @returns get/set/subscribe, shaped for `useSyncExternalStore`.
		 */
		function createStore(initial) {
			let value = initial;
			const listeners = new Set();
			return {
				get: () => value,
				set: (next) => {
					value = next;
					for (const listener of [...listeners]) listener();
				},
				subscribe: (listener) => {
					listeners.add(listener);
					return () => { listeners.delete(listener); };
				},
			};
		}

		/** The one pending confirmation, or null when the dialog is closed. */
		const pending = createStore(null);

		/** Read the pending confirmation as component state. */
		function usePending() {
			return react.useSyncExternalStore(pending.subscribe, pending.get, pending.get);
		}

		/**
		 * Begin one confirmation: open the dialog and, in the background, ask the
		 * Host what the deletion would destroy.
		 * @param sessionId - the row's session id.
		 * @param displayTitle - the row's display title.
		 */
		function openConfirmation(sessionId, displayTitle) {
			pending.set({
				sessionId,
				displayTitle: typeof displayTitle === 'string' && displayTitle.length > 0 ? displayTitle : sessionId,
				acknowledged: false,
				probe: null,
			});
			inspectSession(sessionId).then((probe) => {
				const current = pending.get();
				if (current !== null && current.sessionId === sessionId) pending.set({ ...current, probe });
			}).catch(() => {});
		}

		/**
		 * Close the dialog, unless a delete is in flight.
		 * @param busy - whether a request is currently running.
		 */
		function closeConfirmation(busy) {
			if (busy) return;
			pending.set(null);
		}
		//#endregion

		//#region Host calls
		/**
		 * POST one request to this plugin's own Host route.
		 * @param path - the route path.
		 * @param body - the JSON body.
		 * @returns the route's `value` payload.
		 * @throws an Error carrying the Host's `error.code` for a refusal.
		 */
		async function postToHost(path, body) {
			const response = await fetch(path, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body),
				credentials: 'same-origin',
			});
			let payload = null;
			try {
				payload = await response.json();
			} catch {
				payload = null;
			}
			if (response.ok && payload !== null && payload.ok === true) return payload.value ?? {};
			const error = new Error(payload?.error?.message ?? `HTTP ${response.status}`);
			error.code = payload?.error?.code ?? `http-${response.status}`;
			throw error;
		}

		/**
		 * Describe one Conversation without changing it.
		 * @param sessionId - the session to describe.
		 * @returns the Host's report, or null when the route is unreachable.
		 */
		async function inspectSession(sessionId) {
			return postToHost(INSPECT_ROUTE, { sessionId });
		}

		/**
		 * Permanently remove one Conversation.
		 * @param sessionId - the session to delete.
		 * @returns the Host's deletion report.
		 */
		async function deleteSession(sessionId) {
			return postToHost(DELETE_ROUTE, { sessionId });
		}
		//#endregion

		//#region presentation helpers
		/**
		 * Human-readable size for the confirmation line.
		 * @param bytes - a byte count.
		 * @returns a short localized figure.
		 */
		function sizeText(bytes) {
			if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return '';
			const units = ['B', 'KB', 'MB', 'GB'];
			let value = bytes;
			let unit = 0;
			while (value >= 1024 && unit < units.length - 1) {
				value /= 1024;
				unit += 1;
			}
			return `${unit === 0 ? String(Math.round(value)) : value.toFixed(1)} ${units[unit]}`;
		}

		/**
		 * The confirmation body: what is destroyed, plus the size when the Host
		 * answered the probe.
		 * @param state - the pending confirmation.
		 * @param t - the plugin's locale seat.
		 * @returns the description node.
		 */
		function describeRequest(state, t) {
			const lines = [t('confirm.desc', { title: state.displayTitle })];
			const probe = state.probe;
			if (probe !== null && probe !== undefined) {
				if (probe.exists === false) lines.push(t('confirm.missing'));
				else {
					const size = sizeText(probe.sizeBytes);
					if (size !== '') lines.push(t('confirm.size', { size }));
				}
			}
			return lines.join(' ');
		}

		/**
		 * Where a finished deletion put the bytes.
		 *
		 * The Host reports every moved path; the first log directory is the one
		 * worth naming, because that is the folder a user pulls back out of the
		 * Trash.
		 * @param state - the settled confirmation.
		 * @param t - the plugin's locale seat.
		 * @returns the sentence for the success dialog.
		 */
		function trashSentence(state, t) {
			const moved = Array.isArray(state.report?.trashed) ? state.report.trashed : [];
			const first = moved.find((entry) => entry !== null && typeof entry?.to === 'string');
			if (first === undefined) return t('done.missing');
			const size = sizeText(state.report?.freedBytes);
			const sentence = t('done.desc', { path: first.to });
			return size === '' ? sentence : `${sentence} ${size}`;
		}

		/**
		 * Turn one rejection into the sentence to show.
		 * @param error - the thrown value.
		 * @param t - the plugin's locale seat.
		 * @returns the localized message.
		 */
		function failureText(error, t) {
			if (error?.code === 'session-running') return t('confirm.running');
			if (error?.code === 'forbidden') return `HTTP 403: ${String(error.message)}`;
			return error instanceof Error ? error.message : String(error);
		}

		/**
		 * Resolve the menu's own close setter from the seat's occurrence hook.
		 * @param useMenuOpenState - the hook the menu seat injects.
		 * @returns a setter that ignores an unavailable hook.
		 */
		function useMenuClose(useMenuOpenState) {
			const state = typeof useMenuOpenState === 'function' ? useMenuOpenState() : undefined;
			return (open) => {
				if (Array.isArray(state) && typeof state[1] === 'function') state[1](open);
			};
		}
		//#endregion

		//#region components
		/**
		 * The `⋯` menu row.
		 * @param props - the row's session id and title, the menu hook, and the locale seat.
		 * @returns the menu row.
		 */
		function DeleteSessionMenuItem(props) {
			const setMenuOpen = useMenuClose(props.useMenuOpenState);
			return react.createElement(primitives.MenuItemButton, {
				danger: true,
				separatorBefore: true,
				icon: react.createElement(primitives.IconTrashOutlineRegular, { size: 14 }),
				onSelect: () => {
					setMenuOpen(false);
					openConfirmation(props.sessionId, props.displayTitle);
				},
			}, props.t('menu.delete'));
		}

		/**
		 * The hover action beside Archive and Pin.
		 * @param props - the row's session id and title, and the locale seat.
		 * @returns one icon button.
		 */
		function DeleteSessionRowButton(props) {
			return react.createElement(primitives.Tooltip, {
				label: props.t('menu.delete'),
				side: 'bottom',
				align: 'end',
				delayMs: 500,
			}, react.createElement('button', {
				type: 'button',
				className: ROW_BUTTON_CLASS,
				'aria-label': props.t('menu.delete'),
				onClick: () => { openConfirmation(props.sessionId, props.displayTitle); },
			}, react.createElement(primitives.IconTrashOutlineRegular, { size: 14 })));
		}

		/**
		 * Fallback confirmation for a build whose primitives ship no
		 * `RiskConfirmation`: a plain modal, still two-step.
		 * @param props - the confirmation state, its setters, and the locale seat.
		 * @returns the modal.
		 */
		function PlainConfirmDialog(props) {
			const { state, t, busy, onCancel, onConfirm, onAcknowledgedChange } = props;
			return react.createElement(primitives.Modal, {
				open: true,
				onClose: onCancel,
				closeLabel: t('close'),
				title: t('confirm.title'),
				description: describeRequest(state, t),
				footer: [
					react.createElement(primitives.Button, { key: 'cancel', variant: 'outline', disabled: busy, onClick: onCancel }, t('cancel')),
					react.createElement(primitives.Button, {
						key: 'confirm',
						variant: 'primary',
						disabled: busy || state.acknowledged !== true,
						onClick: onConfirm,
					}, busy ? t('confirm.pending') : t('confirm.action')),
				],
			}, react.createElement('label', { key: 'ack', style: { display: 'flex', gap: '8px', alignItems: 'center' } }, [
				react.createElement('input', {
					key: 'input',
					type: 'checkbox',
					checked: state.acknowledged === true,
					disabled: busy,
					'data-modal-autofocus': true,
					onChange: (event) => { onAcknowledgedChange(event.currentTarget.checked === true); },
				}),
				react.createElement('span', { key: 'label' }, t('confirm.ack')),
			]));
		}

		/**
		 * The `shell.overlay` dialog: the irreversible confirmation, then the
		 * failure report if the Host refused.
		 * @param props - the locale seat and the callback that forgets a deleted
		 * session's main-view selection.
		 * @returns the open dialog, or null while nothing is pending.
		 */
		function DeleteSessionDialog(props) {
			const state = usePending();
			const [busy, setBusy] = react.useState(false);
			const t = props.t;
			if (state === null) return null;
			const cancel = () => { closeConfirmation(busy); };
			if (state.phase === 'failed') {
				return react.createElement(primitives.Modal, {
					open: true,
					onClose: cancel,
					closeLabel: t('close'),
					title: t('confirm.failed'),
					description: state.error,
					footer: react.createElement(primitives.Button, { variant: 'outline', onClick: cancel }, t('close')),
				});
			}
			if (state.phase === 'done') {
				return react.createElement(primitives.Modal, {
					open: true,
					onClose: cancel,
					closeLabel: t('close'),
					title: t('done.title'),
					description: trashSentence(state, t),
					footer: react.createElement(primitives.Button, { variant: 'outline', onClick: cancel }, t('close')),
				});
			}
			const confirm = () => {
				const target = state.sessionId;
				setBusy(true);
				deleteSession(target).then((result) => {
					setBusy(false);
					const current = pending.get();
					if (current !== null && current.sessionId === target) {
						pending.set({ ...current, phase: 'done', report: result });
					}
					try {
						props.forgetDeletedSession?.(target);
					} catch (error) {
						console.warn('[dsh-session-delete] clearing the main view failed:', error);
					}
				}).catch((error) => {
					setBusy(false);
					const current = pending.get();
					if (current === null || current.sessionId !== target) return;
					pending.set({ ...current, phase: 'failed', error: failureText(error, t) });
				});
			};
			const acknowledge = (value) => {
				const current = pending.get();
				if (current !== null && current.sessionId === state.sessionId) pending.set({ ...current, acknowledged: value === true });
			};
			const surface = primitives.RiskConfirmation ?? PlainConfirmDialog;
			if (surface === PlainConfirmDialog) {
				return react.createElement(PlainConfirmDialog, { state, t, busy, onCancel: cancel, onConfirm: confirm, onAcknowledgedChange: acknowledge });
			}
			return react.createElement(surface, {
				open: true,
				title: t('confirm.title'),
				description: describeRequest(state, t),
				acknowledgeLabel: t('confirm.ack'),
				cancelLabel: t('cancel'),
				closeLabel: t('close'),
				confirmLabel: busy ? t('confirm.pending') : t('confirm.action'),
				acknowledged: state.acknowledged === true,
				disabled: busy,
				onAcknowledgedChange: acknowledge,
				onCancel: cancel,
				onConfirm: confirm,
			});
		}
		//#endregion

		/** Inject the client services this half reads. */
		const inject = ['slots', 'locale'];

		/**
		 * Register this plugin's contributions.
		 *
		 * Every seat goes through `ctx.slots.inject`, which waits for the seat's
		 * declaration and removes the contribution when that declaration
		 * collapses — the discipline the seat's owner documents for plugins.
		 * @param ctx - Client Cordis context.
		 */
		function apply(ctx) {
			if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_TAG_ID)}]`) === null) {
				const tag = document.createElement('style');
				tag.dataset.plugin = NS;
				tag.dataset.pluginCss = STYLE_TAG_ID;
				tag.textContent = CSS;
				document.head.appendChild(tag);
			}
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), `${NS}: dictionaries`);

			/**
			 * Forget a deleted Conversation's main-view selection.
			 *
			 * Read-only against the Workspace service and skipped whenever the
			 * current selection is a different session, so opening the row's delete
			 * action never closes an unrelated conversation.
			 * @param sessionId - the session that was just deleted.
			 */
			const forgetDeletedSession = (sessionId) => {
				const uiWorkspace = ctx.get('uiWorkspace');
				if (uiWorkspace === undefined || uiWorkspace === null) return;
				const current = typeof uiWorkspace.selection?.getSnapshot === 'function'
					? uiWorkspace.selection.getSnapshot()?.sessionId
					: undefined;
				if (current === sessionId && typeof uiWorkspace.clearMain === 'function') uiWorkspace.clearMain();
			};

			ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
				name: 'sidebar.workspaces.session.menu.item',
				id: 'session-delete.menu',
				order: 500,
				locale: NS,
			}, DeleteSessionMenuItem));

			ctx.slots.inject('sidebar.workspaces.session.row.action', () => ctx.slots.register({
				name: 'sidebar.workspaces.session.row.action',
				id: 'session-delete.row',
				order: 300,
				locale: NS,
			}, DeleteSessionRowButton));

			ctx.slots.inject('shell.overlay', () => ctx.slots.register({
				name: 'shell.overlay',
				id: 'session-delete.confirm',
				locale: NS,
				inject: () => ({ forgetDeletedSession }),
			}, DeleteSessionDialog));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
