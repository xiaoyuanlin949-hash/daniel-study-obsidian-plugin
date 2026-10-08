/*
 * DANIEL STUDY — Obsidian plugin.
 *
 * A thin client over the Study API running on the VPS. It deliberately holds no
 * study logic of its own:
 *
 *  - Materials are uploaded to the server; the server stores the original, does
 *    the extraction, indexes it, and renders the note this plugin writes.
 *  - Quiz grading, weak points, closure and progress are computed server-side,
 *    where attempts are protected by append-only database triggers. This plugin
 *    can never rewrite a score.
 *  - AI answers come back with validated citations. An answer is only written
 *    into a note when you press the button, and it is always marked as AI output.
 *
 * Plain JavaScript on purpose: no bundler, no node_modules, no build step. The
 * file Obsidian loads is the file you can read. Works on desktop and mobile —
 * no Node APIs, no local file paths, no child processes.
 */

const {
	ItemView,
	Modal,
	Notice,
	Platform,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	requestUrl,
} = require("obsidian");

/** V2 view identity. Stable: changing it would orphan open tabs. */
const VIEW_TYPE_DANIEL_STUDY = "daniel-study-view";

/** The five daily sections, in the order §4 fixes them. */
const SECTIONS = [
	{ id: "today", label: "今天" },
	{ id: "courses", label: "课程" },
	{ id: "materials", label: "资料" },
	{ id: "review", label: "复习" },
	{ id: "progress", label: "进度" },
];

/**
 * The bottom bar a phone gets.
 *
 * Same five destinations, but the last one is 我的 rather than 进度: on a phone
 * the fifth slot is where people look for settings and their own state, and
 * 进度 alone does not cover "this app and my account". The page behind it is the
 * progress view plus the few controls that have nowhere else to live on a small
 * screen — nothing is added or removed, only re-labelled and re-ordered.
 */
const MOBILE_SECTIONS = [
	{ id: "today", label: "今天", icon: "☀" },
	{ id: "courses", label: "课程", icon: "▤" },
	{ id: "materials", label: "资料", icon: "▦" },
	{ id: "review", label: "复习", icon: "↻" },
	{ id: "progress", label: "我的", icon: "◍" },
];

/** The six things a phone should be able to start without hunting. */
const MOBILE_ACTIONS = [
	{ id: "today", icon: "☀", title: "今天", desc: "今天的安排", run: "today" },
	{ id: "continue", icon: "▶", title: "继续学习", desc: "接着上次继续", run: "continue" },
	{ id: "photo", icon: "✎", title: "拍手写", desc: "拍照识别笔记", run: "photo" },
	{ id: "ask", icon: "AI", title: "问 AI", desc: "基于你的资料", run: "ask" },
	{ id: "quiz", icon: "✓", title: "做题", desc: "考我", run: "quiz" },
	{ id: "review", icon: "↻", title: "复习", desc: "待复习内容", run: "review" },
];

/**
 * The guide, as a vault note rather than a help window.
 *
 * It lives in the vault so that the copy on the phone is the same file, synced by
 * the same mechanism as everything else — and so that reading it, marking it up
 * or adding to it needs no special screen.
 */
const GUIDE_NOTE = "README-使用说明.md";

/**
 * Below this many characters of ready material, the day's plan can only be a
 * review of almost nothing — so Today says so, instead of quietly producing
 * questions about a scrap of text. A page of real material is thousands of
 * characters; this is a safety net, not a quality bar.
 */
const THIN_CORPUS_CHARS = 600;

const DEFAULT_SETTINGS = {
	// Left empty on purpose: the endpoint is deployment detail, not program code.
	apiBase: "",
	apiToken: "",
	askK: 6,
	allowWeb: false,
	/** Daily mode hides the engineering surface. It never deletes anything. */
	dailyMode: true,
	/** Open the dashboard when the vault is opened. */
	autoOpen: true,
};

class DanielStudyPlugin extends Plugin {
	async onload() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		// Normalise to a strict boolean on load, so a missing key, a string, or a
		// truthy leftover from an older settings file all resolve to OFF.
		this.settings.allowWeb = this.settings.allowWeb === true;
		this.settings.dailyMode = this.settings.dailyMode !== false;
		this.settings.autoOpen = this.settings.autoOpen !== false;
		this.settings.askK = Number.isFinite(Number(this.settings.askK))
			? Math.max(1, Math.min(20, Math.round(Number(this.settings.askK))))
			: DEFAULT_SETTINGS.askK;

		this.addSafeCommand({
			id: "import-material",
			name: "导入资料（PDF / PPTX / DOCX / TXT / MD）",
			callback: () => this.importMaterial(),
		});
		// One AI surface, one name. The scope rides along with where you are
		// rather than being a thing to choose before you start, so these read as
		// three ways into the same door — kept as separate commands because the
		// keyboard is faster than clicking a chip, but never presented as three
		// different features.
		this.addSafeCommand({
			id: "ask-this-material",
			name: "问 AI：当前资料",
			callback: () => this.ask("material"),
		});
		this.addSafeCommand({
			id: "ask-this-course",
			name: "问 AI：当前课程",
			callback: () => this.ask("course"),
		});
		this.addSafeCommand({
			id: "ask-all-knowledge",
			name: "问 AI：全部知识库",
			callback: () => this.ask("all"),
		});
		this.addSafeCommand({
			id: "import-handwriting-photo",
			name: "拍手写笔记（拍照）",
			callback: () => this.importHandwriting(true),
		});
		this.addSafeCommand({
			id: "import-handwriting-gallery",
			name: "拍手写笔记（从相册/文件选）",
			callback: () => this.importHandwriting(false),
		});
		this.addSafeCommand({
			id: "search-knowledge-base",
			name: "搜索知识库",
			callback: () => new SearchModal(this.app, this).open(),
		});
		this.addSafeCommand({
			id: "generate-quiz",
			name: "让 AI 出题",
			callback: () => this.generateQuiz(),
		});
		this.addSafeCommand({
			id: "take-quiz",
			name: "打开当前测验开始作答",
			callback: () => this.takeQuiz(),
		});
		this.addSafeCommand({
			id: "activate-assessment",
			name: "启用当前测验",
			callback: () => this.activateAssessment(),
		});
		this.addSafeCommand({
			id: "create-review-session",
			name: "生成复习清单",
			callback: () => this.createReview(),
		});
		this.addSafeCommand({
			id: "set-material-course",
			name: "给这份资料指定课程",
			callback: () => this.setMaterialCourse(),
		});
		this.addSafeCommand({
			id: "sync-server-notes",
			name: "从服务器同步卡片",
			callback: () => this.syncServerNotes(),
		});
		this.addSafeCommand({
			id: "open-dashboard",
			name: "打开 DANIEL STUDY 首页",
			callback: () => this.openNote("DANIEL STUDY.md"),
		});
		this.addSafeCommand({
			id: "test-connection",
			name: "测试服务器连接",
			callback: () => this.testConnection(),
		});

		// Clickable actions inside a material note come back through this
		// protocol, so a material's own action links work — on desktop and on
		// mobile — without depending on which file happens to be focused.
		this.registerObsidianProtocolHandler("daniel-study", (params) =>
			this.guarded("Daniel Study 链接", () => this.onProtocol(params)),
		);

		// ---- V2 shell ------------------------------------------------------ //
		this.registerView(VIEW_TYPE_DANIEL_STUDY, (leaf) => new DanielStudyView(leaf, this));

		this.addRibbonIcon("book-open", "打开 DANIEL STUDY", () => {
			this.guarded("打开 DANIEL STUDY", () => this.activateView());
		});

		this.addSafeCommand({
			id: "open-study",
			name: "打开 DANIEL STUDY（今天）",
			callback: () => this.activateView("today"),
		});
		this.addSafeCommand({
			id: "toggle-advanced-mode",
			name: "切换高级模式（显示文件库与工程视图）",
			callback: () => this.setDailyMode(!this.settings.dailyMode, true),
		});

		// Enter daily mode now, then open the dashboard once the workspace is
		// ready. Both are skipped when the user has turned them off.
		this.app.workspace.onLayoutReady(() => {
			this.guarded("启动 DANIEL STUDY", async () => {
				if (this.settings.dailyMode) this.applyDailyMode(true);
				if (this.settings.autoOpen) await this.activateView();
			});
		});

		this.addSettingTab(new StudySettingTab(this.app, this));
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	/**
	 * Register a command whose failures are never silent.
	 *
	 * A command callback that throws inside Obsidian produces no dialog, no
	 * notice and no visible change — the command simply appears to do nothing.
	 * That is exactly the bug this wrapper exists to prevent: anything thrown
	 * below becomes a visible message, and the full error still goes to the
	 * developer console.
	 */
	addSafeCommand(spec) {
		this.addCommand({
			id: spec.id,
			name: spec.name,
			callback: () => this.guarded(spec.name, spec.callback),
		});
	}

	async guarded(label, fn) {
		try {
			return await fn();
		} catch (error) {
			const message = error && error.message ? error.message : String(error);
			console.error("[Daniel Study] " + label + " failed:", error);
			new Notice("Daniel Study · " + label + " 出错：\n" + message, 15000);
			return undefined;
		}
	}

	// ----------------------------------------------------------------- HTTP --

	headers(extra) {
		return Object.assign({ Authorization: `Bearer ${this.settings.apiToken}` }, extra || {});
	}

	async api(path, options) {
		options = options || {};
		let base;
		try {
			base = this.assertSafeBase(this.settings.apiBase);
		} catch (error) {
			return { ok: false, status: 0, data: null, error: error.message };
		}
		if (!this.settings.apiToken) {
			return { ok: false, status: 0, data: null, error: "尚未填写 API Token（设置 → Daniel Study）" };
		}

		try {
			const response = await requestUrl({
				url: base + path,
				method: options.method || "GET",
				headers: options.raw
					? this.headers({ "Content-Type": options.contentType })
					: this.headers({ "Content-Type": "application/json" }),
				body: options.raw
					? options.raw
					: options.body === undefined
						? undefined
						: JSON.stringify(options.body),
				throw: false,
			});

			const text = response.text || "";
			let data = null;
			if (text) {
				try {
					data = JSON.parse(text);
				} catch (e) {
					data = text;
				}
			}
			const ok = response.status >= 200 && response.status < 300;
			return {
				ok: ok,
				status: response.status,
				data: data,
				error: ok ? undefined : (data && data.detail) || `HTTP ${response.status}`,
			};
		} catch (error) {
			return {
				ok: false,
				status: 0,
				data: null,
				error: `无法连接服务器：${error && error.message ? error.message : String(error)}`,
			};
		}
	}

	async testConnection() {
		const result = await this.api("/health");
		if (!result.ok) {
			new Notice(`连接失败：${result.error}`, 9000);
			return;
		}
		const corpus = (result.data && result.data.corpus) || {};
		new Notice(
			`连接成功\n模型：${(result.data && result.data.model) || "未配置"}\n` +
				`材料：${corpus.materials || 0} 份 / ${corpus.chunks || 0} 个片段`,
			9000,
		);
	}

	// ------------------------------------------------------- note utilities --

	activeFile() {
		const file = this.app.workspace.getActiveFile();
		if (!file) return null;
		// Guarded: `file instanceof undefined` would throw, which is one of the
		// ways a command can fail without saying anything.
		return TFile && file instanceof TFile ? file : null;
	}

	frontmatter(file) {
		const cache = this.app.metadataCache.getFileCache(file);
		const fm = cache && cache.frontmatter;
		// Always an object. A non-object here (a malformed block, or a cache in a
		// state we did not anticipate) would let a *field value* like "material"
		// escape as if it were the whole record — which is how a string ends up
		// where an App or a Component is expected.
		return fm && typeof fm === "object" && !Array.isArray(fm) ? fm : {};
	}

	/**
	 * Frontmatter for a file, falling back to reading the file itself.
	 *
	 * Obsidian fills its metadata cache asynchronously, so a note written from
	 * outside Obsidian — by a sync, or by the Study API — can be open with an
	 * empty cache. `frontmatter()` then returns {} and anything that needs `id`
	 * fails for no visible reason. Reading the leading block directly removes
	 * that dependency.
	 */
	async frontmatterResolved(file) {
		const cached = this.frontmatter(file);
		if (cached && cached.id) return cached;
		try {
			const parsed = this.parseFrontmatter(await this.app.vault.read(file));
			if (parsed.id) {
				return Object.assign({}, cached, parsed);
			}
		} catch (error) {
			console.error("[Daniel Study] could not read frontmatter for " + file.path, error);
		}
		return cached;
	}

	/** Minimal reader for the leading metadata block — flat key: value pairs only. */
	parseFrontmatter(text) {
		const out = {};
		const block = (text || "").match(/^---\r?\n([\s\S]*?)\r?\n---/);
		if (!block) return out;
		for (const line of block[1].split(/\r?\n/)) {
			const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
			if (!kv) continue;
			let value = kv[2].trim();
			if (
				(value.startsWith('"') && value.endsWith('"')) ||
				(value.startsWith("'") && value.endsWith("'"))
			) {
				value = value.slice(1, -1);
			}
			if (value !== "") out[kv[1]] = value;
		}
		return out;
	}

	/** Write a generated note, creating folders, and only touch it if it changed. */
	async writeNote(path, content, silent) {
		const clean = String(path).replace(/^\/+/, "");
		const parts = clean.split("/");
		parts.pop();
		if (parts.length) await this.ensureFolder(parts.join("/"));

		const existing = this.app.vault.getAbstractFileByPath(clean);
		if (existing instanceof TFile) {
			const current = await this.app.vault.read(existing);
			if (current === content) return existing;
			await this.app.vault.modify(existing, content);
			if (!silent) new Notice(`已更新 ${clean}`);
			return existing;
		}
		const created = await this.app.vault.create(clean, content);
		if (!silent) new Notice(`已生成 ${clean}`);
		return created;
	}

	async ensureFolder(path) {
		const parts = String(path).split("/").filter(Boolean);
		let current = "";
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			if (!this.app.vault.getAbstractFileByPath(current)) {
				try {
					await this.app.vault.createFolder(current);
				} catch (e) {
					/* created concurrently */
				}
			}
		}
	}

	/**
	 * Guard for the API base URL.
	 *
	 * Only http/https, no embedded credentials, and the host must be on the
	 * allow-list below. The base is configuration, and configuration is untrusted
	 * input — a wrong or hostile value would otherwise turn every command into a
	 * request forwarder.
	 *
	 * On address ranges: this endpoint is a `*.ts.net` name that resolves into
	 * Tailscale's 100.64.0.0/10 space, so a blanket "reject private, loopback and
	 * reserved addresses" rule would reject the user's own server and break the
	 * plugin outright. The allow-list is therefore the control, and it is a
	 * strictly narrower one than a range check: only these four hosts are ever
	 * contacted, redirects are not followed, and the path is fixed by the caller.
	 */
	assertSafeBase(raw) {
		const value = String(raw || "").trim();
		let url;
		try {
			url = new URL(value);
		} catch (error) {
			throw new Error("API 地址无法解析：" + value);
		}
		if (url.protocol !== "https:" && url.protocol !== "http:") {
			throw new Error("API 地址必须以 http:// 或 https:// 开头");
		}
		if (url.username || url.password) {
			throw new Error("API 地址不能包含用户名或密码");
		}
		if (url.pathname && url.pathname !== "/") {
			throw new Error("API 地址不应包含路径：" + url.pathname);
		}
		// The guard enforces the *shape* of the endpoint and refuses a host that was
		// not configured — it does not hard-code one. An earlier version listed the
		// author's own server, which both leaked their topology and refused to talk
		// to any other deployment. Allowed: the configured host, plus loopback.
		let configuredHost = "";
		try {
			configuredHost = String(new URL(this.settings.apiBase || "").hostname || "").toLowerCase();
		} catch (e) {
			configuredHost = "";
		}
		const allowed = [configuredHost, "localhost", "127.0.0.1", "[::1]", "::1"].filter(Boolean);
		const host = String(url.hostname || "").toLowerCase();
		if (!allowed.includes(host)) {
			throw new Error("拒绝访问未授权的地址：" + host);
		}
		return url.origin;
	}

	// ------------------------------------------------------------------ mode --

	/**
	 * Toggle the daily-mode surface.
	 *
	 * Two layers on purpose: the class drives the CSS rules, and the sidebars are
	 * collapsed through Obsidian's own API. The class alone was not enough — the
	 * left ribbon stayed visible, so the sidebar is collapsed as well. Both are
	 * reversible: nothing is removed, and turning the mode off restores the
	 * layout exactly (the split keeps its own state).
	 */
	applyDailyMode(enabled) {
		const on = enabled === true;
		document.body.classList.toggle("ds-daily", on);

		const { leftSplit } = this.app.workspace;
		try {
			if (on) {
				if (leftSplit && leftSplit.collapse) leftSplit.collapse();
			} else if (leftSplit && leftSplit.expand) {
				leftSplit.expand();
			}
		} catch (error) {
			// A layout that does not support collapse must not break the mode.
			console.error("[Daniel Study] could not toggle the sidebar", error);
		}
	}

	async setDailyMode(enabled, notify) {
		this.settings.dailyMode = enabled === true;
		await this.saveSettings();
		this.applyDailyMode(this.settings.dailyMode);

		if (this.settings.dailyMode) {
			const { rightSplit } = this.app.workspace;
			try {
				if (rightSplit && rightSplit.collapse) rightSplit.collapse();
			} catch (error) {
				console.error("[Daniel Study] could not collapse the right sidebar", error);
			}
		}

		if (notify) {
			new Notice(
				this.settings.dailyMode
					? "已回到日常模式（工程视图已隐藏，数据未改动）"
					: "已开启高级模式：文件库与工程视图已恢复",
				6000,
			);
		}
		this.refreshViews();
	}

	refreshViews() {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_DANIEL_STUDY)) {
			if (leaf.view instanceof DanielStudyView) leaf.view.render();
		}
	}

	/** Open (or focus) the V2 dashboard, optionally on a given section. */
	async activateView(section) {
		const { workspace } = this.app;
		const existing = workspace.getLeavesOfType(VIEW_TYPE_DANIEL_STUDY);
		let leaf = existing.length ? existing[0] : null;

		if (!leaf) {
			// Reuse an empty tab rather than adding a new one on every launch.
			const active = workspace.activeLeaf;
			const view = active && active.view;
			const isEmptyTab = !!view && view.getViewType() === "markdown" && !view.file;
			leaf = workspace.getLeaf(isEmptyTab ? false : "tab");
			await leaf.setViewState({ type: VIEW_TYPE_DANIEL_STUDY, active: true });
		}

		workspace.revealLeaf(leaf);
		if (section && leaf.view instanceof DanielStudyView) {
			await leaf.view.setSection(section);
		}
	}

	/** One entry point for every clickable action link in a note. */
	async onProtocol(params) {
		const action = (params && params.action) || "";
		const materialId = (params && params.material) || null;
		const course = (params && params.course) || null;

		if (action === "ask") {
			if (materialId) {
				new AskModal(this.app, this, "material", materialId).open();
			} else {
				await this.ask("material");
			}
			return;
		}
		if (action === "quiz") {
			await this.generateQuiz(materialId, course);
			return;
		}
		if (action === "take") {
			const assessmentId = (params && params.assessment) || null;
			if (!assessmentId) {
				new Notice("链接里缺少测验 ID", 8000);
				return;
			}
			const result = await this.api(`/assessments/${assessmentId}`);
			if (!result.ok) {
				new Notice(`读取失败：${result.error}`, 10000);
				return;
			}
			const assessment = result.data;
			if (!assessment.questions || !assessment.questions.length) {
				new Notice("这张测验还没有题目", 8000);
				return;
			}
			new QuizModal(this.app, this, assessment).open();
			return;
		}
		if (action === "setcourse") {
			if (!materialId) {
				new Notice("链接里缺少材料 ID", 8000);
				return;
			}
			new CourseModal(this.app, this, {
				id: materialId,
				title: (params && params.title) || "",
				course: course || "",
			}).open();
			return;
		}
		if (action === "search") {
			new SearchModal(this.app, this).open();
			return;
		}
		new Notice("未知的 Daniel Study 操作：" + action, 8000);
	}

	/** Assign or clear a material's course. The note moves with it. */
	async setMaterialCourse() {
		const file = this.activeFile();
		if (!file) {
			new Notice("请先打开一份材料笔记", 8000);
			return;
		}
		const fm = await this.frontmatterResolved(file);
		if (fm.type !== "material" || !fm.id) {
			new Notice("请打开一份材料笔记", 8000);
			return;
		}
		new CourseModal(this.app, this, fm).open();
	}

	async applyMaterialCourse(materialId, course) {
		const result = await this.api(`/materials/${materialId}/course`, {
			method: "POST",
			body: { course: course || null },
		});
		if (!result.ok) {
			new Notice(`设置失败：${result.error}`, 10000);
			return;
		}
		const data = result.data;
		if (data.note_path && data.note_content) {
			await this.writeNote(data.note_path, data.note_content, true);
		}
		// The note follows the course, so the old file must go — otherwise it
		// lingers in the previous folder as an orphan.
		if (data.remove_path && data.remove_path !== data.note_path) {
			const old = this.app.vault.getAbstractFileByPath(data.remove_path);
			if (old instanceof TFile) {
				await this.app.vault.delete(old);
			}
		}
		new Notice(course ? `已设为课程：${course}` : "已清除课程");
		if (data.note_path) await this.openNote(data.note_path);
	}

	/** Course notes in this vault, so the picker offers real values. */
	courseNames() {
		const names = new Set();
		for (const f of this.app.vault.getMarkdownFiles()) {
			const fm = this.frontmatter(f);
			if (fm && fm.type === "course") names.add(f.basename);
		}
		return Array.from(names).sort();
	}

	async openNote(path) {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) {
			await this.app.workspace.getLeaf(false).openFile(file);
		} else {
			new Notice(`找不到笔记：${path}`, 8000);
		}
	}

	// ------------------------------------------------------------- commands --

	async importMaterial() {
		const input = document.createElement("input");
		input.type = "file";
		input.accept = ".pdf,.pptx,.docx,.txt,.md,.markdown";
		input.multiple = true;

		input.onchange = () =>
			this.guarded("导入资料", async () => {
			const files = Array.from(input.files || []);
			if (!files.length) return;
			new Notice(`正在上传 ${files.length} 个文件…`, 6000);
			let ok = 0;
			for (const file of files) {
				const buffer = await file.arrayBuffer();
				const form = this.buildMultipart(file.name, buffer);
				const result = await this.api("/materials/import", {
					method: "POST",
					raw: form.body,
					contentType: `multipart/form-data; boundary=${form.boundary}`,
				});
				if (!result.ok) {
					new Notice(`导入失败 ${file.name}：${result.error}`, 12000);
					continue;
				}
				ok += 1;
				await this.writeNote(result.data.note_path, result.data.note_content, true);
				const material = result.data.material;
				if (material.processing_status === "failed") {
					new Notice(
						`${file.name} 已保存，但没有提取到文字：${material.processing_error || ""}`,
						15000,
					);
				}
			}
			new Notice(`导入完成：${ok}/${files.length}`, 8000);
			});

		input.click();
	}

	/**
	 * 拍手写笔记 — read a photographed page and file it as a material.
	 *
	 * The picker is a real file input: on a phone, `capture` opens the camera and
	 * omitting it opens the album, which is how Obsidian Mobile can offer both
	 * without pretending to be a native app. The page is compressed and read on
	 * the server by a local OCR engine — never by a language model.
	 */
	async importHandwriting(useCamera) {
		const input = document.createElement("input");
		input.type = "file";
		input.accept = "image/*";
		if (useCamera) input.setAttribute("capture", "environment");

		input.onchange = () =>
			this.guarded("拍手写笔记", async () => {
			const files = Array.from(input.files || []);
			if (!files.length) return;
			new Notice(useCamera ? "正在识别照片…" : "正在识别图片…", 15000);
			let saved = 0;
			for (const file of files) {
				const buffer = await file.arrayBuffer();
				const form = this.buildMultipart(file.name || "page.jpg", buffer);
				const result = await this.api("/materials/handwriting", {
					method: "POST",
					raw: form.body,
					contentType: `multipart/form-data; boundary=${form.boundary}`,
				});
				if (!result.ok) {
					// The server says why in plain words (unreadable, too large,
					// nothing recognised); passing that on beats "failed".
					new Notice("识别失败：" + (result.error || "未知原因"), 15000);
					continue;
				}
				saved += 1;
				await this.writeNote(result.data.note_path, result.data.note_content, true);
				const text = result.data.material && result.data.material.processing_status === "ready";
				new Notice(
					text
						? "已识别并保存：" + result.data.material.title
						: "已保存，但没有识别出文字。",
					8000,
				);
				await this.openNote(result.data.note_path);
			}
			if (saved) new Notice("一共保存了 " + saved + " 页。", 6000);
			});

		input.click();
	}

	/** Ask the server to re-flow an OCR page. Never adds content, only structure. */
	async tidyMaterial(materialId) {
		new Notice("正在整理排版…（只调整格式，不会增加内容）", 15000);
		const result = await this.api("/materials/" + materialId + "/tidy", { method: "POST", body: {} });
		if (!result.ok) throw new Error(result.error || "整理失败。");
		const note = await this.api("/materials/" + materialId + "/note");
		if (note.ok) {
			await this.writeNote(note.data.note_path, note.data.note_content, true);
			await this.openNote(note.data.note_path);
		}
		new Notice(
			result.data.cached
				? "这份材料之前已经整理过了，直接用了上次的结果。"
				: "整理完成。原文仍保留在材料里。",
			8000,
		);
		return result.data;
	}

	buildMultipart(filename, data) {
		const boundary = `----danielstudy${Date.now().toString(16)}`;
		const encoder = new TextEncoder();
		const head = encoder.encode(
			`--${boundary}\r\n` +
				`Content-Disposition: form-data; name="file"; filename="${String(filename).replace(/"/g, "")}"\r\n` +
				`Content-Type: application/octet-stream\r\n\r\n`,
		);
		const tail = encoder.encode(`\r\n--${boundary}--\r\n`);
		const body = new Uint8Array(head.length + data.byteLength + tail.length);
		body.set(head, 0);
		body.set(new Uint8Array(data), head.length);
		body.set(tail, head.length + data.byteLength);
		return { body: body.buffer, boundary: boundary };
	}

	/**
	 * Open the ask dialog.
	 *
	 * `explicitRefId` is passed by the clickable links in a material note, so the
	 * action works even if no file is focused or its metadata cache is empty.
	 * Anything that cannot be resolved says so in a notice — a command that
	 * appears to do nothing is the bug this guards against.
	 */
	async ask(scope, explicitRefId, explicitLabel) {
		let refId = explicitRefId || null;
		let label = explicitLabel || "";

		if (!refId) {
			const file = this.activeFile();
			const fm = file ? await this.frontmatterResolved(file) : {};

			if (scope === "material") {
				refId = fm.id || null;
				if (!refId) {
					new Notice(
						"没有找到材料 ID。\n" +
							"请确认打开的是材料笔记（frontmatter 里需要 id）。\n" +
							"当前文件：" +
							(file ? file.path : "（没有打开的文件）"),
						15000,
					);
					return;
				}
				label = fm.title || (file ? file.basename : "");
			}
			if (scope === "course") {
				refId = fm.course || fm.code || (file ? file.basename : null);
				if (!refId) {
					new Notice("无法确定课程。请打开课程笔记，或在 frontmatter 里写 course", 8000);
					return;
				}
				label = refId;
			}
		}

		new AskModal(this.app, this, scope, refId, label).open();
	}

	async generateQuiz(explicitMaterialId, explicitCourse, questionCount) {
		let materialId = explicitMaterialId || null;
		let course = explicitCourse || null;
		if (!materialId && !course) {
			const file = this.activeFile();
			const fm = file ? await this.frontmatterResolved(file) : {};
			materialId = fm.id || null;
			course = fm.course || null;
		}
		// Asked for from the dashboard or the review page with nothing open: fall
		// back to the whole knowledge base rather than refusing, because "考我"
		// is a request to practise, not a request about a particular file.
		const scope = materialId ? "material" : course ? "course" : "all";
		const refId = materialId || course || null;

		new Notice("正在生成测验…", 8000);
		const result = await this.api("/ai/quiz", {
			method: "POST",
			body: {
				scope: scope,
				ref_id: refId,
				course: course,
				count: questionCount || 5,
				kind: "quiz",
				save: true,
			},
		});
		if (!result.ok) {
			new Notice(`生成失败：${result.error}`, 12000);
			return;
		}
		await this.writeNote(result.data.note_path, result.data.note_content, true);
		// A draft becomes a live record the moment it is answered — the server
		// promotes it — so there is no activation step to explain. Go straight
		// into the questions: the user asked to practise, not to read a note.
		// The note is still written, so the record exists and syncs.
		const count = (result.data.questions || []).length;
		const generated = result.data.assessment;
		const assessmentId = generated && generated.id ? generated.id : null;
		if (assessmentId && count) {
			const full = await this.api(`/assessments/${assessmentId}`);
			if (full.ok && full.data.questions && full.data.questions.length) {
				new Notice(`已出 ${count} 道题，做完自动记账`, 5000);
				new QuizModal(this.app, this, full.data).open();
				return;
			}
		}
		await this.openNote(result.data.note_path);
		new Notice(`已生成 ${count} 道题`, 8000);
	}

	async activateAssessment() {
		const file = this.activeFile();
		if (!file) return;
		const fm = await this.frontmatterResolved(file);
		if (fm.type !== "assessment" || !fm.id) {
			new Notice("请打开一张测验笔记", 8000);
			return;
		}
		const result = await this.api(`/assessments/${fm.id}/status`, {
			method: "POST",
			body: { status: "ready" },
		});
		if (!result.ok) {
			new Notice(`启用失败：${result.error}`, 10000);
			return;
		}
		await this.writeNote(result.data.note_path, result.data.note_content, true);
		new Notice("已启用（status: ready）");
	}

	async takeQuiz() {
		const file = this.activeFile();
		if (!file) return;
		const fm = await this.frontmatterResolved(file);
		if (fm.type !== "assessment" || !fm.id) {
			new Notice("请打开一张测验笔记", 8000);
			return;
		}
		if (fm.status === "archived") {
			new Notice("该测验已归档，不能作答", 8000);
			return;
		}
		const result = await this.api(`/assessments/${fm.id}`);
		if (!result.ok) {
			new Notice(`读取失败：${result.error}`, 10000);
			return;
		}
		const assessment = result.data;
		if (!assessment.questions || !assessment.questions.length) {
			new Notice("这张测验还没有题目", 8000);
			return;
		}
		new QuizModal(this.app, this, assessment).open();
	}

	async createReview() {
		const file = this.activeFile();
		const fm = file ? await this.frontmatterResolved(file) : {};
		const result = await this.api("/reviews", {
			method: "POST",
			body: { course: fm.course || null, limit: 10 },
		});
		if (!result.ok) {
			new Notice(`无法生成复习：${result.error}`, 10000);
			return;
		}
		await this.writeNote(result.data.note_path, result.data.note_content, true);
		await this.openNote(result.data.note_path);
		new Notice(`已生成复习清单（${result.data.review.item_count} 项）`, 8000);
	}

	async syncServerNotes() {
		new Notice("正在从服务器同步…", 6000);
		const result = await this.api("/sync/notes", {
			method: "POST",
			body: { include: ["today", "progress", "weakpoints", "assessments", "materials"] },
		});
		if (!result.ok) {
			new Notice(`同步失败：${result.error}`, 12000);
			return;
		}
		let written = 0;
		for (const note of result.data.notes || []) {
			await this.writeNote(note.path, note.content, true);
			written += 1;
		}
		new Notice(`同步完成：${written} 张卡片`, 8000);
	}

	/** Append an AI answer to the active note, clearly marked as AI output. */
	async insertAiAnswer(question, answer, citations, webSources) {
		const file = this.activeFile();
		if (!file) {
			new Notice("没有打开的笔记，答案未插入", 8000);
			return;
		}
		const lines = ["", "---", "", "> [!ai] AI 回答 · origin: ai · 非学习记录", `> **问题：** ${question}`, ">"];
		for (const line of String(answer).split("\n")) lines.push(`> ${line}`);
		lines.push(">");
		if (citations.length) {
			lines.push("> **来源：**");
			for (const citation of citations) {
				lines.push(`> [${citation.index}] 《${citation.material_title}》 ${citation.location || ""}`);
			}
		}
		if (webSources.length) {
			lines.push("> **联网来源（非知识库）：**");
			webSources.forEach((source, index) => {
				lines.push(`> [W${index + 1}] ${source.title} — ${source.url}`);
			});
		}
		lines.push("");
		await this.app.vault.append(file, lines.join("\n"));
		new Notice("答案已插入当前笔记（标记为 AI 输出）");
	}
}

// ---------------------------------------------------------------- Ask modal --

/**
 * The one AI surface.
 *
 * Scope is inherited from wherever this was opened — a material page asks about
 * that material, a course about that course, the dashboard about everything —
 * and the user can override it. Web search is off unless turned on here, chat is
 * not stored, and "保存为笔记" is the only thing that puts an answer into the
 * knowledge base.
 */
class AskModal extends Modal {
	constructor(app, plugin, scope, refId, refLabel) {
		super(app);
		this.dsPlugin = plugin;
		// NOT `this.scope`: Obsidian's Modal already declares `scope: Scope` and
		// owns it for keymaps. Overwriting it with a string makes Obsidian try to
		// set properties on that string, which throws
		//   Cannot create property 'win' on string 'material'
		// the moment the modal opens.
		this.askScope = scope || "all";
		this.refId = refId || null;
		this.refLabel = refLabel || "";
		this.dsCached = false;
	}

	static SCOPE_LABELS = { material: "当前资料", course: "当前课程", all: "全部知识库" };

	onOpen() {
		const el = this.contentEl;
		el.addClass("ds-modal");
		el.addClass("ds-ask");
		el.createEl("h3", { text: "问 AI" });

		// ---- scope: inherited, and overridable ----------------------------- //
		const scopeBox = el.createDiv({ cls: "ds-field" });
		scopeBox.createDiv({ cls: "ds-field-label", text: "在哪个范围内提问？" });
		const scopeRow = scopeBox.createDiv({ cls: "ds-minutes-row" });
		const self = this;
		this.scopeChips = {};
		for (const scope of ["material", "course", "all"]) {
			const chip = scopeRow.createEl("button", {
				cls: "ds-chip" + (scope === this.askScope ? " is-active" : ""),
				text: AskModal.SCOPE_LABELS[scope],
			});
			// A scope with nothing behind it is offered disabled rather than
			// silently answering about everything.
			if (scope === "material" && !this.refId) {
				chip.disabled = true;
				chip.title = "从资料页面打开才能问「当前资料」";
			}
			if (scope === "course" && this.askScope !== "course") {
				chip.disabled = true;
				chip.title = "从课程页面打开才能问「当前课程」";
			}
			chip.addEventListener("click", () => {
				self.askScope = scope;
				for (const key of Object.keys(self.scopeChips)) {
					self.scopeChips[key].toggleClass("is-active", key === scope);
				}
			});
			this.scopeChips[scope] = chip;
		}
		scopeBox.createDiv({ cls: "ds-subtle", text: this.scopeHint() });

		// ---- the question --------------------------------------------------- //
		const questionField = el.createDiv({ cls: "ds-field" });
		questionField.createDiv({ cls: "ds-field-label", text: "问题" });
		const textarea = questionField.createEl("textarea", { cls: "ds-input ds-textarea" });
		textarea.rows = 3;
		textarea.placeholder = "想问什么就写什么…";
		textarea.focus();

		// ---- web search: strictly off unless asked for here ----------------- //
		const webRow = el.createDiv({ cls: "ds-inline" });
		const allowWeb = webRow.createEl("input", { type: "checkbox" });
		allowWeb.checked = this.dsPlugin.settings.allowWeb === true;
		const webLabel = webRow.createEl("label", {
			cls: "ds-subtle",
			text: "允许联网搜索（默认关闭 —— 只用你的知识库）",
		});
		// A bare label inside the row does not toggle on its own without a `for`
		// attribute, so the click is wired explicitly rather than left to look
		// clickable and do nothing.
		webLabel.addEventListener("click", () => {
			allowWeb.checked = !allowWeb.checked;
		});

		const actions = el.createDiv({ cls: "ds-inline ds-modal-actions" });
		const go = actions.createEl("button", { cls: "ds-btn ds-btn-primary", text: "提问" });
		const saveButton = actions.createEl("button", { cls: "ds-btn ds-btn-ghost", text: "保存为笔记" });
		saveButton.disabled = true;
		// Obsidian gives a modal no close button of its own, and a phone has no
		// Escape key: without this, the only way out of a half-typed question is
		// to answer it.
		const closeButton = actions.createEl("button", { cls: "ds-btn ds-btn-ghost", text: "关闭" });
		closeButton.addEventListener("click", () => this.close());

		const output = el.createDiv({ cls: "ds-answer" });

		let last = null;

		async function run() {
			const value = String(textarea.value || "").trim();
			if (!value) {
				questionField.addClass("is-invalid");
				textarea.focus();
				new Notice("请输入问题");
				return;
			}
			questionField.removeClass("is-invalid");
			go.disabled = true;
			go.textContent = "思考中…";
			output.empty();
			output.createDiv({ cls: "ds-subtle", text: "正在检索你的知识库…" });

			const result = await self.dsPlugin.api("/ai/ask", {
				method: "POST",
				body: {
					question: value,
					scope: self.askScope,
					ref_id: self.askScope === "all" ? null : self.refId,
					k: self.dsPlugin.settings.askK,
					allow_web: allowWeb.checked,
				},
			});
			go.disabled = false;
			go.textContent = "提问";

			if (!result.ok) {
				output.empty();
				output.createDiv({ cls: "ds-error", text: "没有拿到回答：" + (result.error || "未知原因") });
				return;
			}
			const data = result.data;
			self.dsCached = data.cached === true;
			self.renderAnswer(output, value, data);
			last = data;
			saveButton.disabled = false;
		}

		go.addEventListener("click", () => this.dsPlugin.guarded("问 AI", run));
		textarea.addEventListener("keydown", (event) => {
			if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
				event.preventDefault();
				this.dsPlugin.guarded("问 AI", run);
			}
		});

		// Saving is what puts an answer into the knowledge base; asking alone
		// never does.
		saveButton.addEventListener("click", () =>
			this.dsPlugin.guarded("保存为笔记", async () => {
				if (!last) return;
				const question = String(textarea.value || "").trim();
				const res = await this.dsPlugin.api("/ai/answers", {
					method: "POST",
					body: {
						answer: last.answer || "",
						question: question,
						scope: last.scope || this.askScope,
						ref_id: last.ref_id || null,
						citations: last.citations || [],
						web_sources: last.web_sources || [],
						model: last.model || null,
						usage: last.usage || {},
					},
				});
				// The note is written either way: the record and the note are two
				// views of the same decision, but a note the user asked for must
				// not be lost because the bookkeeping failed.
				await this.dsPlugin.insertAiAnswer(
					question,
					last.answer || "",
					last.citations || [],
					last.web_sources || [],
				);
				new Notice(
					res.ok ? "已保存为笔记，并记入知识库。" : "已保存为笔记（记录失败：" + res.error + "）",
					6000,
				);
				this.close();
			}),
		);
	}

	scopeHint() {
		if (this.askScope === "material") {
			return "只在《" + (this.refLabel || "当前资料") + "》里找答案，不作检索。";
		}
		if (this.askScope === "course") {
			return "在这门课程的资料里检索。";
		}
		return "在整个知识库里检索。";
	}

	/**
	 * The answer, with its sources.
	 *
	 * Concise first and detailed on request — one answer, disclosed in stages,
	 * rather than two different answers pretending to be a setting.
	 */
	renderAnswer(output, question, data) {
		output.empty();

		if (data.cached === true) {
			output.createDiv({ cls: "ds-pill ds-pill-muted", text: "来自缓存 · 本次没有调用 AI" });
		}
		if (data.grounded === false) {
			output.createDiv({ cls: "ds-pill ds-pill-warn", text: "知识库中沒有找到依据" });
		}

		const answer = String(data.answer || "").trim() || "(空)";
		const paragraphs = answer.split(/\n{2,}/);
		const short = paragraphs[0];
		const rest = paragraphs.slice(1).join("\n\n");

		const body = output.createDiv({ cls: "ds-answer-body" });
		body.createDiv({ cls: "ds-answer-short", text: short });

		if (rest) {
			const more = body.createDiv({ cls: "ds-answer-more" });
			more.createDiv({ cls: "ds-answer-text", text: rest });
			more.style.display = "none";
			const toggle = output.createEl("button", { cls: "ds-btn ds-btn-ghost", text: "展开详细解释" });
			let open = false;
			toggle.addEventListener("click", () => {
				open = !open;
				more.style.display = open ? "block" : "none";
				toggle.setText(open ? "收起详细解释" : "展开详细解释");
			});
		}

		// Sources are shown by default, and the two kinds are never mixed: what
		// came from the user's own material is a different claim from a web page.
		const citations = data.citations || [];
		output.createDiv({ cls: "ds-sources-title", text: "资料来源（你的知识库）" });
		if (citations.length) {
			for (const citation of citations) {
				const row = output.createDiv({ cls: "ds-source" });
				row.createDiv({
					cls: "ds-source-head",
					text: "[" + citation.index + "] 《" + (citation.material_title || "资料") + "》" +
						(citation.location ? " · " + citation.location : ""),
				});
				if (citation.snippet) row.createDiv({ cls: "ds-source-snippet", text: citation.snippet });
			}
		} else {
			output.createDiv({ cls: "ds-subtle", text: "没有引用任何资料 —— 回答没有依据时不会编造来源。" });
		}

		// Three facts, not one: whether the user turned the switch on, whether the
		// search ran, and whether anything came back. Deriving the heading from the
		// result count alone made an enabled search that returned nothing read as
		// "（未启用）", which is a different statement and a false one.
		const web = data.web_sources || [];
		const webOn = data.web_requested === true;
		let webTitle = "互联网来源";
		let webNote = "";
		if (!webOn) {
			webTitle += "（未启用）";
			webNote = data.web_message || "本次没有联网。知识库是唯一来源。";
		} else if (web.length) {
			webTitle += "（已联网 · " + web.length + " 条）";
		} else if (data.web_status === "unavailable") {
			webTitle += "（已启用，服务器无法连接搜索服务）";
			webNote = data.web_message || "服务器当前无法连接搜索服务。";
		} else {
			webTitle += "（已启用，本次没有结果）";
			webNote = data.web_message || "已联网搜索，但这次没有拿到可用结果。";
		}
		output.createDiv({ cls: "ds-sources-title", text: webTitle });
		if (web.length) {
			web.forEach((source, index) => {
				output.createDiv({ cls: "ds-source" }).createDiv({
					cls: "ds-source-head",
					text: "[W" + (index + 1) + "] " + (source.title || "") + " — " + (source.url || ""),
				});
			});
		} else if (webNote) {
			output.createDiv({ cls: "ds-subtle", text: webNote });
		}

		const dropped = (data.invalid_citations || []).length;
		if (dropped) {
			output.createDiv({ cls: "ds-subtle", text: "（已剔除 " + dropped + " 个无效引用编号）" });
		}
	}

	onClose() {
		this.contentEl.empty();
	}
}

// ------------------------------------------------------------- Search modal --

/**
 * How long to practise, then begin.
 *
 * The same shape as the day's length on Today — 5 / 10 / 20 / 30 / 自定义 with
 * 10 minutes as the default (§28) — because it is the same kind of decision and
 * should not have to be learned twice.
 */
class QuizDurationModal extends Modal {
	/** Minutes → how many questions that roughly buys. */
	static QUESTIONS_PER_MINUTE = 0.5;

	constructor(app, plugin, onStarted) {
		super(app);
		this.dsPlugin = plugin;
		this.dsOnStarted = onStarted;
		this.dsMinutes = 10;
	}

	onOpen() {
		const el = this.contentEl;
		el.addClass("ds-modal");
		el.addClass("ds-quiz");
		el.createEl("h3", { text: "考我" });
		el.createDiv({ cls: "ds-subtle", text: "想练多久？大概会出这么多题。" });

		const row = el.createDiv({ cls: "ds-minutes-row" });
		for (const minutes of [5, 10, 20, 30]) {
			const chip = row.createEl("button", {
				cls: "ds-chip" + (minutes === 10 ? " is-active" : ""),
				text: minutes + " 分钟",
			});
			chip.addEventListener("click", () => {
				this.dsMinutes = minutes;
				for (const other of Array.from(row.children)) other.removeClass("is-active");
				chip.addClass("is-active");
				hint.setText(this.hint());
			});
		}
		const custom = row.createEl("button", { cls: "ds-chip", text: "自定义" });
		custom.addEventListener("click", () => {
			const holder = el.createDiv({ cls: "ds-minutes-custom" });
			const input = holder.createEl("input", { type: "number", cls: "ds-input" });
			input.min = "2";
			input.max = "120";
			input.value = String(this.dsMinutes);
			const confirm = holder.createEl("button", { cls: "ds-btn ds-btn-ghost", text: "确定" });
			confirm.addEventListener("click", () => {
				const value = Math.round(Number(input.value));
				if (!Number.isFinite(value) || value < 2 || value > 120) {
					new Notice("请输入 2 到 120 分钟。");
					return;
				}
				this.dsMinutes = value;
				for (const other of Array.from(row.children)) other.removeClass("is-active");
				custom.addClass("is-active");
				custom.setText(value + " 分钟");
				hint.setText(this.hint());
				holder.remove();
			});
			input.focus();
		});

		const hint = el.createDiv({ cls: "ds-subtle", text: this.hint() });
		const actions = el.createDiv({ cls: "ds-inline ds-modal-actions" });
		const start = actions.createEl("button", { cls: "ds-btn ds-btn-primary", text: "开始" });
		const close = actions.createEl("button", { cls: "ds-btn ds-btn-ghost", text: "取消" });
		close.addEventListener("click", () => this.close());
		start.addEventListener("click", () =>
			this.dsPlugin.guarded("考我", async () => {
				this.close();
				await this.dsPlugin.generateQuiz(null, null, this.questionCount());
				if (this.dsOnStarted) await this.dsOnStarted();
			}),
		);
	}

	questionCount() {
		return Math.max(1, Math.min(20, Math.round(this.dsMinutes * QuizDurationModal.QUESTIONS_PER_MINUTE)));
	}

	hint() {
		return this.dsMinutes + " 分钟 · 大约 " + this.questionCount() + " 道题";
	}

	onClose() {
		this.contentEl.empty();
	}
}

class SearchModal extends Modal {
	constructor(app, plugin) {
		super(app);
		this.plugin = plugin;
	}

	onOpen() {
		const contentEl = this.contentEl;
		contentEl.createEl("h3", { text: "搜索知识库" });

		const input = contentEl.createEl("input", { type: "text", placeholder: "关键词…" });
		input.style.width = "100%";
		input.focus();

		const output = contentEl.createDiv();
		output.style.marginTop = "10px";
		output.style.whiteSpace = "pre-wrap";
		output.style.maxHeight = "55vh";
		output.style.overflowY = "auto";

		const plugin = this.plugin;
		async function run() {
			const query = input.value.trim();
			if (!query) return;
			output.setText("搜索中…");
			const result = await plugin.api(`/search?q=${encodeURIComponent(query)}&limit=20`);
			if (!result.ok) {
				output.setText(`失败：${result.error}`);
				return;
			}
			const results = result.data.results || [];
			if (!results.length) {
				output.setText("知识库中没有匹配内容。");
				return;
			}
			output.empty();
			results.forEach((hit, index) => {
				const row = output.createDiv();
				row.style.marginBottom = "10px";
				row.createEl("strong", {
					text: `${index + 1}. 《${hit.material_title}》 ${hit.location || ""}`,
				});
				row.createEl("div", { text: hit.snippet || "" });
			});
		}

		input.onkeydown = (event) => {
			if (event.key === "Enter") {
				event.preventDefault();
				void run();
			}
		};
	}

	onClose() {
		this.contentEl.empty();
	}
}

// --------------------------------------------------------------- Quiz modal --

class QuizModal extends Modal {
	constructor(app, plugin, assessment) {
		super(app);
		this.plugin = plugin;
		this.assessment = assessment;
		this.answers = new Map();
		this.index = 0;
	}

	get questions() {
		return this.assessment.questions || [];
	}

	onOpen() {
		this.render();
	}

	render() {
		const contentEl = this.contentEl;
		contentEl.empty();
		contentEl.createEl("h3", { text: this.assessment.title });
		contentEl.createEl("p", {
			text: `第 ${this.index + 1} / ${this.questions.length} 题`,
			cls: "setting-item-description",
		});

		const question = this.questions[this.index];
		contentEl.createEl("div", { text: question.question }).style.fontWeight = "600";
		contentEl.createEl("div", { text: "" }).style.height = "8px";

		const self = this;
		if (Array.isArray(question.options) && question.options.length) {
			question.options.forEach((option, optionIndex) => {
				const label = contentEl.createEl("label");
				label.style.display = "block";
				const radio = label.createEl("input", { type: "radio" });
				radio.name = "option";
				radio.value = String(optionIndex + 1);
				if (self.answers.get(question.id) === String(optionIndex + 1)) radio.checked = true;
				radio.onchange = () => self.answers.set(question.id, String(optionIndex + 1));
				label.appendChild(document.createTextNode(` ${option}`));
			});
		} else {
			const textarea = contentEl.createEl("textarea", { attr: { rows: "3" } });
			textarea.style.width = "100%";
			textarea.value = this.answers.get(question.id) || "";
			textarea.oninput = () => self.answers.set(question.id, textarea.value);
		}

		const buttons = contentEl.createDiv({ cls: "modal-button-container" });
		if (this.index > 0) {
			buttons.createEl("button", { text: "上一题" }).onclick = () => {
				self.index -= 1;
				self.render();
			};
		}
		if (this.index < this.questions.length - 1) {
			buttons.createEl("button", { text: "下一题", cls: "mod-cta" }).onclick = () => {
				self.index += 1;
				self.render();
			};
		} else {
			// guarded, not `void`: an unanswered submission that fails silently is
			// the worst case in the whole quiz flow.
			buttons.createEl("button", { text: "提交", cls: "mod-cta" }).onclick = () =>
				this.plugin.guarded("提交答卷", () => self.submit());
		}
		buttons.createEl("button", { text: "取消" }).onclick = () => self.close();
	}

	async submit() {
		const self = this;
		const payload = this.questions.map((question) => ({
			question_id: question.id,
			answer: self.answers.get(question.id) || "",
		}));
		const clientRequestId = `obsidian-${Date.now()}-${Math.random().toString(16).slice(2)}`;

		const result = await this.plugin.api(`/assessments/${this.assessment.id}/attempts`, {
			method: "POST",
			body: { answers: payload, client_request_id: clientRequestId },
		});
		if (!result.ok) {
			new Notice(`提交失败：${result.error}`, 12000);
			return;
		}

		const data = result.data;
		if (data.note_path && data.note_content) {
			await this.plugin.writeNote(data.note_path, data.note_content, true);
		}
		const summary = data.weak_points || {};
		const opened = (summary.opened || []).length;
		const closed = (summary.closed || []).length;
		new Notice(
			`得分 ${data.score}/${data.max_score}（${data.score_percent}%）\n` +
				`新增薄弱点 ${opened} · 关闭薄弱点 ${closed}`,
			12000,
		);
		this.showResults(data);
	}

	showResults(data) {
		const contentEl = this.contentEl;
		contentEl.empty();
		contentEl.createEl("h3", { text: `结果：${data.score_percent}%` });
		const list = contentEl.createDiv();
		for (const item of data.results || []) {
			const row = list.createDiv();
			row.style.marginBottom = "8px";
			row.createEl("div", { text: `${item.ordinal}. ${item.question}` });
			row.createEl("div", {
				text: item.correct ? "✅ 正确" : `❌ 错误 · 正确答案：${item.correct_answer}`,
			});
			if (!item.correct && item.given) {
				row.createEl("div", { text: `你的答案：${item.given}`, cls: "setting-item-description" });
			}
		}
		contentEl.createEl("p", {
			text: "本次作答已永久保存。返回首页就能看到更新后的薄弱点与进度。",
			cls: "setting-item-description",
		});
		contentEl
			.createDiv({ cls: "modal-button-container" })
			.createEl("button", { text: "关闭" }).onclick = () => this.close();
	}

	onClose() {
		this.contentEl.empty();
	}
}

// ------------------------------------------------------------- Course modal --

class CourseModal extends Modal {
	constructor(app, plugin, frontmatter) {
		super(app);
		this.plugin = plugin;
		this.fm = frontmatter;
	}

	onOpen() {
		const contentEl = this.contentEl;
		contentEl.createEl("h3", { text: "选择课程" });
		contentEl.createEl("p", {
			text: `材料：${this.fm.title || this.fm.file || ""}`,
			cls: "setting-item-description",
		});

		const existing = this.plugin.courseNames();
		if (existing.length) {
			contentEl.createEl("p", { text: "已有课程：", cls: "setting-item-description" });
			const row = contentEl.createDiv({ cls: "modal-button-container" });
			for (const name of existing) {
				row.createEl("button", { text: name }).onclick = () => {
					void this.plugin.applyMaterialCourse(this.fm.id, name);
					this.close();
				};
			}
		} else {
			contentEl.createEl("p", {
				text: "还没有课程笔记。可以直接输入课程名，例如 BIO101。",
				cls: "setting-item-description",
			});
		}

		const input = contentEl.createEl("input", {
			type: "text",
			placeholder: "课程名，例如 BIO101",
		});
		input.style.width = "100%";
		input.value = this.fm.course || "";
		input.focus();

		const self = this;
		const buttons = contentEl.createDiv({ cls: "modal-button-container" });
		const save = buttons.createEl("button", { text: "保存", cls: "mod-cta" });
		const clear = buttons.createEl("button", { text: "清除课程" });
		buttons.createEl("button", { text: "取消" }).onclick = () => self.close();

		async function commit(value) {
			await self.plugin.applyMaterialCourse(self.fm.id, value);
			self.close();
		}

		save.onclick = () => void commit(input.value.trim());
		clear.onclick = () => void commit("");
		input.onkeydown = (event) => {
			if (event.key === "Enter") {
				event.preventDefault();
				void commit(input.value.trim());
			}
		};
	}

	onClose() {
		this.contentEl.empty();
	}
}

// ------------------------------------------------------------ Settings tab --

/**
 * First-run goal creation. Three fields and nothing else (§9): a name, an exam
 * date, and how long a day should be. Everything downstream — modules, daily
 * plan, review intervals — is derived from these.
 */
class GoalModal extends Modal {
	constructor(app, plugin, onCreated) {
		super(app);
		// Prefixed on purpose: `Modal` owns several property names, and writing
		// over one of them throws deep inside Obsidian's own code.
		this.dsPlugin = plugin;
		this.dsOnCreated = onCreated;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.addClass("ds-modal");
		contentEl.createEl("h3", { text: "创建学习目标" });
		contentEl.createDiv({
			cls: "ds-subtle",
			text: "只需要这三项。之后每天学什么，由系统自动安排。",
		});

		const nameWrap = contentEl.createDiv({ cls: "ds-field" });
		nameWrap.createDiv({ cls: "ds-field-label", text: "目标名称" });
		const name = nameWrap.createEl("input", { type: "text", cls: "ds-input" });
		name.placeholder = "例如：大学英语四级 CET-4";

		const dateWrap = contentEl.createDiv({ cls: "ds-field" });
		dateWrap.createDiv({ cls: "ds-field-label", text: "考试日期（可留空）" });
		const dateInput = dateWrap.createEl("input", { type: "date", cls: "ds-input" });

		const minWrap = contentEl.createDiv({ cls: "ds-field" });
		minWrap.createDiv({ cls: "ds-field-label", text: "每天学习时长" });
		const minutes = minWrap.createEl("input", { type: "number", cls: "ds-input" });
		minutes.min = "5";
		minutes.max = "600";
		minutes.value = "60";

		const actions = contentEl.createDiv({ cls: "ds-inline ds-modal-actions" });
		const submit = actions.createEl("button", { cls: "ds-btn ds-btn-primary", text: "创建" });
		submit.addEventListener("click", () =>
			this.dsPlugin.guarded("创建学习目标", async () => {
				const title = String(name.value || "").trim();
				if (!title) {
					// Say what is wrong at the field, rather than a toast that
					// disappears while the dialog stays open.
					nameWrap.addClass("is-invalid");
					name.focus();
					throw new Error("请填写目标名称。");
				}
				nameWrap.removeClass("is-invalid");
				const daily = Math.round(Number(minutes.value || 60));
				if (!Number.isFinite(daily) || daily < 5 || daily > 600) {
					minWrap.addClass("is-invalid");
					throw new Error("每天学习时长请在 5 到 600 分钟之间。");
				}
				minWrap.removeClass("is-invalid");

				const body = { title: title, daily_minutes: daily };
				if (dateInput.value) body.exam_date = dateInput.value;
				const res = await this.dsPlugin.api("/goals", { method: "POST", body: body });
				if (!res.ok) throw new Error(res.error || "创建目标失败。");

				// The planner needs a day to plan; doing it now means the user
				// sees today's work the moment the dialog closes.
				const replan = await this.dsPlugin.api("/plan/replan", {
					method: "POST",
					body: { minutes: daily },
				});
				if (!replan.ok) throw new Error(replan.error || "目标已创建，但今天的计划没能生成。");

				this.close();
				new Notice("目标已创建，今天的计划已经安排好。", 5000);
				if (this.dsOnCreated) await this.dsOnCreated();
			}),
		);
		const cancel = actions.createEl("button", { cls: "ds-btn ds-btn-ghost", text: "取消" });
		cancel.addEventListener("click", () => this.close());

		name.focus();
	}

	onClose() {
		this.contentEl.empty();
	}
}

/**
 * The continuous study session (§26–§30).
 *
 * One step on screen at a time, with a short self-check that is a confirmation
 * and not a quiz. Pausing, resuming and leaving are all real operations against
 * the server, so closing the window mid-session loses nothing — reopening
 * continues from the same step.
 */
class StudySessionModal extends Modal {
	constructor(app, plugin, runState, onFinished) {
		super(app);
		this.dsPlugin = plugin;
		this.dsRun = runState;
		this.dsOnFinished = onFinished;
		this.dsBusy = false;
		this.dsFocus = false;
		this.dsTick = null;
	}

	onOpen() {
		this.modalEl.addClass("ds-session");
		this.render();
		// A visible clock: the whole point of a session is that it ends.
		this.dsTick = window.setInterval(() => this.paintClock(), 15000);
	}

	onClose() {
		if (this.dsTick) {
			window.clearInterval(this.dsTick);
			this.dsTick = null;
		}
		this.setFocus(false);
		this.contentEl.empty();
	}

	setFocus(on) {
		this.dsFocus = on;
		document.body.classList.toggle("ds-focus", on);
		this.modalEl.toggleClass("is-focus", on);
		this.render();
	}

	paintClock() {
		const el = this.contentEl.querySelector(".ds-session-clock");
		if (el) el.setText(this.elapsedLabel());
	}

	elapsedLabel() {
		const started = (this.dsRun && this.dsRun.run && this.dsRun.run.started_at) || null;
		if (!started) return "";
		const startedAt = Date.parse(started.includes("T") ? started : started.replace(" ", "T") + "Z");
		if (Number.isNaN(startedAt)) return "";
		const minutes = Math.max(0, Math.round((Date.now() - startedAt) / 60000));
		return "已学习 " + minutes + " 分钟";
	}

	async refresh(data) {
		this.dsRun = data;
		this.render();
	}

	async send(path, body) {
		if (this.dsBusy) return null;
		this.dsBusy = true;
		try {
			const res = await this.dsPlugin.api(path, { method: "POST", body: body || {} });
			if (!res.ok) throw new Error(res.error || "操作失败。");
			return res.data;
		} finally {
			this.dsBusy = false;
		}
	}

	render() {
		const el = this.contentEl;
		el.empty();
		el.addClass("ds-session-body");

		const state = this.dsRun || {};
		const run = state.run || {};
		const pending = state.pending || [];
		const current = state.current || null;
		const progress = state.progress || {};

		if (run.status === "done" || (!pending.length && !current)) {
			this.renderFinished(state);
			return;
		}

		// ---- header: where we are ------------------------------------------- //
		const head = el.createDiv({ cls: "ds-session-head" });
		head.createDiv({
			cls: "ds-session-step",
			text: "第 " + ((progress.done || 0) + 1) + " / " + (progress.total || 0) + " 项",
		});
		head.createDiv({ cls: "ds-session-clock", text: this.elapsedLabel() });

		const bar = el.createDiv({ cls: "ds-progress" });
		bar.createDiv({ cls: "ds-progress-fill" }).style.width =
			Math.round(((progress.done || 0) / Math.max(1, progress.total || 1)) * 100) + "%";

		// ---- the step ------------------------------------------------------- //
		const card = el.createDiv({ cls: "ds-session-card" });
		card.createDiv({ cls: "ds-session-kind", text: this.kindLabel(current) });
		card.createDiv({ cls: "ds-session-title", text: (current && current.title) || "学习任务" });
		if (current && current.detail) {
			card.createDiv({ cls: "ds-session-detail", text: current.detail });
		}
		if (current && current.reason) {
			card.createDiv({ cls: "ds-session-reason", text: "为什么安排： " + current.reason });
		}
		if (current && current.material_title) {
			card.createDiv({ cls: "ds-session-material", text: "材料： " + current.material_title });
		}

		const openMaterial = el.createDiv({ cls: "ds-inline" });
		if (current && current.material_id) {
			this.button(openMaterial, "打开材料", async () => {
				const res = await this.dsPlugin.api("/materials/" + current.material_id + "/note");
				if (!res.ok) throw new Error(res.error || "打不开材料。");
				await this.dsPlugin.writeNote(res.data.note_path, res.data.note_content, true);
				await this.dsPlugin.openNote(res.data.note_path);
			}, "ghost");
			this.button(openMaterial, "问 AI 这个材料", () =>
				this.dsPlugin.ask("material", current.material_id), "ghost");
		}

		// ---- controls ------------------------------------------------------- //
		const actions = el.createDiv({ cls: "ds-session-actions" });
		this.button(actions, "完成了", () => this.step("done", "done"), "primary");
		this.button(actions, "有点不确定", () => this.step("done", "unsure"), "ghost");
		this.button(actions, "跳过这项", () => this.step("skipped", null), "ghost");

		const footer = el.createDiv({ cls: "ds-session-footer" });
		this.button(
			footer,
			run.status === "paused" ? "继续" : "暂停",
			() => this.togglePause(run),
			"ghost",
		);
		this.button(footer, this.dsFocus ? "退出专注" : "专注模式", () => this.setFocus(!this.dsFocus), "ghost");
		this.button(footer, "结束这次学习", () => this.finishRun(), "ghost");
		// An explicit way out that records nothing. Obsidian does not give this
		// modal a close button, and a phone has no Escape key — without this the
		// only exit would be finishing the session, which is not the same thing.
		// The run stays active, so reopening continues from the same step.
		this.button(footer, "先离开（保留进度）", () => this.close(), "ghost");

		if (run.status === "paused") {
			el.createDiv({ cls: "ds-session-paused", text: "已暂停。继续后从这一项接着做。" });
		}
	}

	kindLabel(task) {
		if (!task) return "学习";
		if (task.kind === "review") return "复习";
		if (task.kind === "quiz") return "练习";
		return "学习";
	}

	button(parent, label, onClick, variant) {
		const cls = "ds-btn" + (variant ? " ds-btn-" + variant : "");
		const node = parent.createEl("button", { cls, text: label });
		node.addEventListener("click", () => this.dsPlugin.guarded(label, onClick));
		return node;
	}

	async step(status, check) {
		const run = (this.dsRun && this.dsRun.run) || {};
		const current = this.dsRun && this.dsRun.current;
		const data = await this.send("/runs/" + run.id + "/advance", {
			task_id: current ? current.id : undefined,
			status: status,
			check: check,
		});
		if (!data) return;
		this.dsRun = data;
		// The server closes the session when the last step is done; go straight
		// to the summary instead of making the user press another button.
		if ((data.run || {}).status === "done" || !(data.pending || []).length) {
			await this.finishRun();
			return;
		}
		this.render();
	}

	async togglePause(run) {
		const path = run.status === "paused" ? "/resume" : "/pause";
		const data = await this.send("/runs/" + run.id + path, {});
		if (!data) return;
		this.dsRun = data;
		this.render();
	}

	async finishRun() {
		// The finished screen can be reached from render() as well as from a
		// click, so this must be safe to call while a finish is in flight —
		// otherwise it re-enters through render() and loops.
		if (this.dsFinishing) return;
		this.dsFinishing = true;
		try {
			const run = (this.dsRun && this.dsRun.run) || {};
			const data = await this.send("/runs/" + run.id + "/finish", {});
			if (!data) return;
			this.dsSummary = data;
			if (this.dsOnFinished) await this.dsOnFinished();
		} finally {
			this.dsFinishing = false;
		}
		this.render();
	}

	/** The completion screen (§28): time, what was done, what needs attention. */
	renderFinished() {
		const el = this.contentEl;
		const summary = this.dsSummary;
		if (!summary) {
			// Reached by reopening an already-finished session: ask the server for
			// the summary rather than assembling numbers locally.
			el.createDiv({ cls: "ds-loading", text: "正在整理这次学习的记录…" });
			this.finishRun();
			return;
		}

		el.createDiv({ cls: "ds-done-title", text: "这次学习完成了" });
		const grid = el.createDiv({ cls: "ds-done-grid" });
		const add = (label, value) => {
			const box = grid.createDiv();
			box.createDiv({ cls: "ds-stat-label", text: label });
			box.createDiv({ cls: "ds-stat-value", text: value });
		};
		add("学习时间", summary.minutes + " 分钟");
		add("完成内容", summary.completed_count + " 项");
		add(
			"表现",
			summary.performance && summary.performance.quiz_attempts_today
				? "今天答题 " + summary.performance.quiz_attempts_today + " 次"
				: "这次没有做题",
		);
		add("需要注意", summary.check_unsure ? summary.check_unsure + " 项不确定" : "无");

		const list = el.createDiv({ cls: "ds-done-list" });
		list.createDiv({ cls: "ds-block-title" }).createSpan({ text: "完成的内容" });
		if ((summary.completed || []).length) {
			for (const title of summary.completed) {
				list.createDiv({ cls: "ds-done-item", text: "· " + title });
			}
		} else {
			list.createDiv({ cls: "ds-subtle", text: "这次没有标记完成的内容。" });
		}

		el.createDiv({ cls: "ds-done-next", text: summary.next_review });
		if (summary.attention) el.createDiv({ cls: "ds-subtle", text: summary.attention });

		const noteWrap = el.createDiv({ cls: "ds-field" });
		noteWrap.createDiv({ cls: "ds-field-label", text: "写点什么（可不填）" });
		const note = noteWrap.createEl("textarea", { cls: "ds-input ds-textarea" });
		note.rows = 3;
		note.value = summary.note || "";

		const actions = el.createDiv({ cls: "ds-inline ds-modal-actions" });
		const save = actions.createEl("button", { cls: "ds-btn ds-btn-primary", text: "保存总结并关闭" });
		save.addEventListener("click", () =>
			this.dsPlugin.guarded("保存总结", async () => {
				const text = String(note.value || "").trim();
				if (text) {
					// Updates rather than re-finishes: finishing twice would
					// record the same study time twice.
					const res = await this.dsPlugin.api("/runs/" + summary.run_id + "/note", {
						method: "POST",
						body: { note: text },
					});
					if (!res.ok) throw new Error(res.error || "保存失败。");
				}
				this.close();
			}),
		);
		save.addClass("ds-btn-lg");
		this.button(actions, "先不写", () => this.close(), "ghost");
	}
}

class StudySettingTab extends PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display() {
		const containerEl = this.containerEl;
		containerEl.empty();
		containerEl.createEl("h2", { text: "Daniel Study 设置" });

		new Setting(containerEl)
			.setName("API 地址")
			.setDesc("VPS 上的 Study 服务（Tailscale HTTPS 地址）")
			.addText((text) =>
				text
					.setPlaceholder("https://your-server.example:10444")
					.setValue(this.plugin.settings.apiBase)
					.onChange(async (value) => {
						this.plugin.settings.apiBase = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("API Token")
			.setDesc("与 VPS 上 deploy/.env 的 STUDY_API_TOKEN 一致")
			.addText((text) => {
				text.inputEl.type = "password";
				text.inputEl.style.width = "22em";
				text.setValue(this.plugin.settings.apiToken).onChange(async (value) => {
					this.plugin.settings.apiToken = value.trim();
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("检索片段数")
			.setDesc("每次提问从知识库取多少个片段作为依据（1–20）")
			.addText((text) =>
				text.setValue(String(this.plugin.settings.askK)).onChange(async (value) => {
					const parsed = Number(value);
					if (!Number.isFinite(parsed)) return;
					this.plugin.settings.askK = Math.max(1, Math.min(20, Math.round(parsed)));
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("默认允许联网")
			.setDesc("关闭时 AI 只使用你的知识库（推荐关闭）")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.allowWeb === true).onChange(async (value) => {
					this.plugin.settings.allowWeb = value === true;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("连接测试")
			.addButton((button) =>
				button.setButtonText("测试连接").onClick(() => void this.plugin.testConnection()),
			);
	}
}

// ------------------------------------------------------------ V2 dashboard --

/**
 * The DANIEL STUDY product shell.
 *
 * Phase 1 scope: this view, its navigation, and hiding the engineering surface.
 * It reads only deterministic endpoints — /today, /stats, /progress, /materials,
 * /weakpoints — so opening it never calls DeepSeek and never waits on a model.
 * Planning, sessions, OCR and quiz changes are later phases and are deliberately
 * absent here; where a feature does not exist yet the UI says so instead of
 * pretending.
 */
class DanielStudyView extends ItemView {
	constructor(leaf, plugin) {
		super(leaf);
		this.plugin = plugin;
		this.section = "today";
		this.state = { status: "idle", error: null, data: null };
	}

	/** A phone is not a small desktop, and the layout should know which it is. */
	get isMobile() {
		try {
			return Platform && Platform.isMobile === true;
		} catch (e) {
			return false;
		}
	}

	get sections() {
		return this.isMobile ? MOBILE_SECTIONS : SECTIONS;
	}

	getViewType() {
		return VIEW_TYPE_DANIEL_STUDY;
	}

	getDisplayText() {
		return "DANIEL STUDY";
	}

	getIcon() {
		return "book-open";
	}

	async onOpen() {
		// Deliberately not `await this.render()`.
		//
		// `onOpen` runs inside Obsidian's budget for opening a view. render() paints
		// the header, the navigation and the loading line *before* it touches the
		// network, so starting it and returning already puts a real screen on the
		// display — whereas awaiting it holds the view open across nine requests,
		// and on a slow Tailscale round trip that exceeds the budget. Obsidian then
		// kills the view with "Failed to load deferred view Error: Timeout" and the
		// dashboard is dead before it has drawn anything, which is exactly what it
		// did on a cold start.
		this.render().catch((error) => {
			// loadData turns a failed request into state, so reaching here means a
			// drawing error — which should be visible rather than swallowed.
			console.error("Daniel Study: 首页绘制失败", error);
		});
	}

	async onClose() {
		this.contentEl.empty();
	}

	async setSection(section) {
		this.section = section;
		await this.reload();
	}

	/**
	 * Re-read everything, then draw.
	 *
	 * render() alone draws from whatever is already in memory, so anything that
	 * changes server state — 刷新, changing the day's length, finishing a session
	 * — must come through here or the screen keeps showing the old numbers.
	 */
	async reload() {
		this.state = { status: "loading", error: null, data: this.state.data };
		await this.render();
	}

	greeting() {
		const hour = new Date().getHours();
		if (hour < 5) return "夜深了";
		if (hour < 12) return "早上好";
		if (hour < 18) return "下午好";
		return "晚上好";
	}

	/** Deterministic reads only. No AI endpoint is touched here. */
	async loadData() {
		const [today, stats, progress, materials, weak, goals, plan, active, detail] = await Promise.all([
			this.plugin.api("/today"),
			this.plugin.api("/stats"),
			this.plugin.api("/progress"),
			this.plugin.api("/materials"),
			this.plugin.api("/weakpoints?status=open"),
			this.plugin.api("/goals"),
			this.plugin.api("/plan"),
			// A read: it reports today's unfinished session without starting one.
			this.plugin.api("/runs/active"),
			// Deterministic arithmetic over stored records — no model involved.
			this.plugin.api("/progress/detail"),
		]);

		const firstError = [
			today,
			stats,
			progress,
			materials,
			weak,
			goals,
			plan,
			active,
			detail,
		].find((r) => !r.ok);
		if (firstError) {
			return { status: "error", error: firstError.error || "无法连接 Study 服务", data: null };
		}
		const goalList = (goals.data && goals.data.goals) || [];
		return {
			status: "ready",
			error: null,
			data: {
				today: today.data || {},
				stats: stats.data || {},
				progress: progress.data || {},
				progressDetail: detail.data || {},
				materials: (materials.data && materials.data.materials) || [],
				weakPoints: (weak.data && weak.data.weak_points) || [],
				goal: goalList.length ? goalList[0] : null,
				plan: plan.data || {},
				activeRun: (active.data && active.data.run) || null,
			},
		};
	}

	// ---- small builders ---------------------------------------------------- //

	card(parent, label, value, note) {
		const el = parent.createDiv({ cls: "ds-card" });
		el.createDiv({ cls: "ds-card-label", text: label });
		el.createDiv({ cls: value ? "ds-card-value" : "ds-card-value ds-value-sm", text: value });
		if (note) el.createDiv({ cls: "ds-card-note", text: note });
		return el;
	}

	button(parent, label, onClick, variant) {
		const cls = "ds-btn" + (variant ? " ds-btn-" + variant : "");
		const el = parent.createEl("button", { cls, text: label });
		el.addEventListener("click", () => {
			// Every click is wrapped: a failure must say so, never do nothing.
			this.plugin.guarded(label, onClick);
		});
		return el;
	}

	/**
	 * The header goal block.
	 *
	 * `undefined` means "not read yet" and must stay visually distinct from
	 * `null` "read, and there is none" — showing "尚未创建学习目标" while the
	 * request is still in flight tells the user something untrue.
	 */
	renderGoalSummary(box, goal) {
		box.createDiv({ cls: "ds-goal-label", text: "当前主要目标" });
		if (goal === undefined) {
			box.createDiv({ cls: "ds-goal-value ds-value-sm", text: "读取中…" });
			return;
		}
		if (!goal) {
			box.createDiv({ cls: "ds-goal-value ds-value-sm", text: "尚未创建学习目标" });
			box.createDiv({
				cls: "ds-goal-note",
				text: "创建后即可自动安排每天的学习内容",
			});
			const acts = box.createDiv({ cls: "ds-inline ds-goal-actions" });
			this.button(acts, "创建学习目标", () => this.openGoalModal(), "primary");
			return;
		}
		box.createDiv({ cls: "ds-goal-value", text: goal.title || "学习目标" });
		const bits = [];
		if (typeof goal.days_to_exam === "number") {
			bits.push(goal.days_to_exam > 0 ? "距离考试还有 " + goal.days_to_exam + " 天" : "考试日期已到");
		} else {
			bits.push("未设置考试日期");
		}
		bits.push("每天 " + (goal.daily_minutes || 60) + " 分钟");
		box.createDiv({ cls: "ds-goal-note", text: bits.join(" · ") });
	}

	openGoalModal() {
		new GoalModal(this.app, this.plugin, () => this.reload()).open();
	}

	/** Local-date ISO. `toISOString` would shift by the UTC offset. */
	todayISO() {
		const now = new Date();
		const month = String(now.getMonth() + 1).padStart(2, "0");
		const day = String(now.getDate()).padStart(2, "0");
		return now.getFullYear() + "-" + month + "-" + day;
	}

	openFolder(path) {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file) {
			this.app.workspace.getLeaf("tab").openFile(file);
			return;
		}
		new Notice("没有找到：" + path, 5000);
	}

	// ---- render ------------------------------------------------------------ //

	async render() {
		const root = this.contentEl;
		root.empty();
		root.addClass("ds-view");
		const inner = root.createDiv({ cls: "ds-inner" });

		// ---- header --------------------------------------------------------- //
		const header = inner.createDiv({ cls: "ds-header" });
		const left = header.createDiv();
		left.createDiv({ cls: "ds-greeting", text: this.greeting() + "，Daniel" });
		left.createDiv({ cls: "ds-header-sub", text: "准备好继续今天的学习了吗？" });
		const meta = left.createDiv({ cls: "ds-header-meta" });
		meta.createSpan({
			text: new Date().toLocaleDateString("zh-CN", {
				month: "long",
				day: "numeric",
				weekday: "long",
			}),
		});
		meta.createSpan({ cls: "ds-dot" });
		meta.createSpan({ text: this.plugin.settings.dailyMode ? "日常模式" : "高级模式" });

		// Goal summary and the advanced entry both live here, in normal flow, so
		// they can never collide with Obsidian's own status area. The values are
		// placeholder-free once data has loaded — render() re-runs with it.
		const goalBox = header.createDiv({ cls: "ds-goal" });
		this.renderGoalSummary(goalBox, this.state.data ? this.state.data.goal : undefined);

		const topActions = goalBox.createDiv({ cls: "ds-inline ds-goal-actions" });
		this.button(
			topActions,
			this.plugin.settings.dailyMode ? "高级模式" : "返回日常模式",
			() => this.plugin.setDailyMode(!this.plugin.settings.dailyMode, true),
			"ghost",
		);
		this.button(topActions, "刷新", () => this.reload(), "ghost");
		// Reachable from both layouts, next to the two controls that are always on
		// screen, so "how do I use this" has an answer inside the app itself.
		this.button(topActions, "怎么用", () => this.plugin.openNote(GUIDE_NOTE), "ghost");

		// ---- navigation: the five daily sections only ----------------------- //
		const nav = inner.createDiv({ cls: this.isMobile ? "ds-nav ds-nav-mobile" : "ds-nav" });
		for (const item of this.sections) {
			const tab = nav.createDiv({
				cls: "ds-nav-item" + (this.section === item.id ? " is-active" : ""),
			});
			// An icon above the label: on a phone the bar is thumbed, and a glyph
			// is what makes a target findable without reading every word.
			if (item.icon) tab.createSpan({ cls: "ds-nav-icon", text: item.icon });
			tab.createSpan({ cls: "ds-nav-label", text: item.label });
			tab.addEventListener("click", () => this.plugin.guarded(item.label, () => this.setSection(item.id)));
		}
		if (this.isMobile) root.addClass("ds-is-mobile");

		if (this.state.status === "idle" || this.state.status === "loading") {
			inner.createDiv({ cls: "ds-loading", text: "正在读取学习数据…" });
			this.state.status = "loading";
			const result = await this.loadData();
			this.state = result;
			await this.render();
			return;
		}

		if (this.state.status === "error") {
			const raw = String(this.state.error || "");
			// "Cannot reach the server" is a different situation from "the server
			// said no", and the user can act on it differently. Saying which one it
			// is beats a generic failure.
			const offline = /无法连接服务器|Network|Failed to fetch|ECONN|timeout|超时/i.test(raw);
			const box = inner.createDiv({ cls: "ds-error" });
			box.createDiv({
				text: offline ? "现在连不上学习服务。" : "暂时读不到学习数据。",
			});
			box.createDiv({
				cls: "ds-subtle",
				text: offline
					? "检查一下网络，或确认 Tailscale 是否连着。已保存的资料和进度都在服务器上，不会丢。"
					: raw,
			});
			if (!offline) box.createDiv({ cls: "ds-subtle", text: raw });
			// reload(), not render(): render() draws from memory and would show the
			// same error again, which is a retry button that cannot retry.
			this.button(box, "重试", () => this.reload(), "primary");
			this.button(box, "先看看已导入的资料", () => this.setSection("materials"), "ghost");
			return;
		}

		const data = this.state.data;
		if (!data) return;

		if (this.section === "files") {
			this.renderFiles(inner);
		} else if (this.section === "today") {
			this.renderToday(inner, data);
		} else if (this.section === "courses") {
			this.renderCourses(inner, data);
		} else if (this.section === "materials") {
			this.renderMaterials(inner, data);
		} else if (this.section === "review") {
			this.renderReview(inner, data);
		} else if (this.section === "progress") {
			this.renderProgress(inner, data);
		}
	}

	/**
	 * Say so when there is not enough material to plan from.
	 *
	 * The planner is honest — it can only build a day out of what has been imported —
	 * but the page was not: with a single short document in the knowledge base it
	 * produced five reviews and a quiz about that document and said nothing about
	 * why. That reads as a broken product rather than an empty one, which is exactly
	 * how it read. One line, in the user's words, with the action that fixes it.
	 *
	 * The threshold is about the *whole* base, not one file: a knowledge base needs
	 * enough text for questions to be about something. Well under a page.
	 */
	renderThinCorpusHint(root, data) {
		const ready = (data.materials || []).filter((m) => m.processing_status === "ready");
		if (!ready.length) return;
		const chars = ready.reduce((total, m) => total + (Number(m.char_count) || 0), 0);
		if (chars >= THIN_CORPUS_CHARS) return;

		const box = root.createDiv({ cls: "ds-hint" });
		box.createDiv({
			cls: "ds-hint-title",
			text: "你的资料一共只有 " + chars.toLocaleString() + " 个字",
		});
		box.createDiv({
			cls: "ds-hint-body",
			text: "每天的计划只能从你导入的资料里出题，所以现在排出来的都是关于这一小段文字的题。"
				+ "先导入一份真正要学的资料，今天的内容才会变成你要学的东西。",
		});
		const actions = box.createDiv({ cls: "ds-inline ds-hint-actions" });
		this.button(actions, "添加资料", () => this.plugin.importMaterial(), "primary");
		this.button(actions, "拍手写笔记", () => this.plugin.importHandwriting(true), "ghost");
	}

	renderToday(root, data) {
		const stats = data.stats || {};
		const progress = data.progress || {};
		const goal = data.goal || null;
		const plan = data.plan || {};
		const tasks = plan.tasks || [];
		const active = data.activeRun || null;
		const mats = progress.materials || {};
		const attempts = progress.attempts || {};
		const weakList = data.weakPoints || [];
		const pending = tasks.filter((t) => t.status === "pending");
		const doneCount = tasks.filter((t) => t.status === "done").length;
		const planned = plan.planned_minutes || 0;

		// ---- hero: what today is, and the one action that matters ----------- //
		const hero = root.createDiv({ cls: "ds-hero" });
		const heroMain = hero.createDiv({ cls: "ds-hero-main" });
		heroMain.createDiv({ cls: "ds-hero-eyebrow", text: "今天" });

		if (!goal) {
			heroMain.createDiv({ cls: "ds-hero-title", text: "先创建一个学习目标" });
			heroMain.createDiv({
				cls: "ds-hero-sub",
				text: "只需要目标名称、考试日期和每天的学习时长，之后每天学什么由系统安排。",
			});
		} else if (!tasks.length) {
			heroMain.createDiv({ cls: "ds-hero-title", text: "今天还没有要学的内容" });
			heroMain.createDiv({
				cls: "ds-hero-sub",
				text: "导入资料后会自动安排；也可以现在就让 AI 根据已有资料出一套练习。",
			});
		} else if (!pending.length) {
			heroMain.createDiv({ cls: "ds-hero-title", text: "今天的任务已经完成" });
			heroMain.createDiv({
				cls: "ds-hero-sub",
				text: "共完成 " + doneCount + " 项。想继续可以再学一轮。",
			});
		} else {
			heroMain.createDiv({
				cls: "ds-hero-title",
				text: active ? "继续今天的学习" : "今天有 " + pending.length + " 项要做",
			});
			heroMain.createDiv({
				cls: "ds-hero-sub",
				text: active
					? "上次学到一半，从上次停下的地方继续即可。"
					: "按下面的顺序完成即可，中途可以随时暂停。",
			});
		}

		const mins = heroMain.createDiv({ cls: "ds-hero-minutes" });
		mins.createSpan({ cls: "n", text: String(planned || (goal ? goal.daily_minutes : 0) || 0) });
		mins.createSpan({
			cls: "u",
			text: planned ? "分钟 · 今日计划" : "分钟 · 每日目标",
		});

		const heroCta = hero.createDiv({ cls: "ds-hero-cta" });
		if (goal && tasks.length) {
			const start = this.button(
				heroCta,
				active ? "继续学习" : pending.length ? "开始今天的学习" : "再学一轮",
				() => this.startSession(),
				"primary",
			);
			start.addClass("ds-btn-lg");
			this.button(heroCta, "看今天要学什么", () => this.scrollToPlan(), "ghost");
		} else if (goal) {
			this.button(heroCta, "添加资料", () => this.plugin.importMaterial(), "primary");
			this.button(heroCta, "让 AI 出题", () => this.plugin.generateQuiz(), "ghost");
		} else {
			this.button(heroCta, "创建学习目标", () => this.openGoalModal(), "primary");
		}

		// On a phone, the six things worth starting lead the page: a thumb should
		// not have to scroll past prose to reach 继续学习.
		if (this.isMobile) this.renderMobileActions(root, active, tasks, goal);

		this.renderThinCorpusHint(root, data);

		// ---- how long today should be --------------------------------------- //
		if (goal) this.renderMinutesPicker(root, goal);

		// ---- body: two columns --------------------------------------------- //
		const cols = root.createDiv({ cls: "ds-cols" });
		const leftCol = cols.createDiv({ cls: "ds-col" });
		const rightCol = cols.createDiv({ cls: "ds-col" });

		const taskTitle = leftCol.createDiv({ cls: "ds-block-title" });
		taskTitle.createSpan({ text: "今天要完成" });
		if (tasks.length) {
			taskTitle.createSpan({
				cls: "ds-count",
				text: doneCount + " / " + tasks.length + " 已完成",
			});
		}

		if (!tasks.length) {
			const empty = leftCol.createDiv({ cls: "ds-empty" });
			empty.createDiv({
				cls: "ds-empty-title",
				text: goal ? "还没有安排今天的内容" : "还没有学习目标",
			});
			empty.createDiv({
				cls: "ds-empty-body",
				text: goal
					? "导入 PDF / PPT / Word 资料后，系统会自动把它排进每天的计划。"
					: "创建目标后，系统会按考试日期和你每天的学习时长自动安排。",
			});
			const acts = empty.createDiv({ cls: "ds-empty-actions" });
			if (goal) {
				this.button(acts, "添加学习资料", () => this.plugin.importMaterial(), "primary");
				this.button(acts, "让 AI 出题", () => this.plugin.generateQuiz());
			} else {
				this.button(acts, "创建学习目标", () => this.openGoalModal(), "primary");
			}
		} else {
			for (const task of tasks) this.taskRow(leftCol, task);
		}

		const matTitle = leftCol.createDiv({ cls: "ds-block-title" });
		matTitle.createSpan({ text: "最近资料" });
		if (data.materials.length) {
			matTitle.createSpan({ cls: "ds-count", text: "共 " + data.materials.length + " 份" });
		}
		if (!data.materials.length) {
			leftCol
				.createDiv({ cls: "ds-empty" })
				.createDiv({ cls: "ds-empty-body", text: "还没有资料。用「添加资料」导入 PDF / PPT / Word / 图片。" });
		} else {
			for (const m of data.materials.slice(0, 5)) this.materialRow(leftCol, m);
		}

		// Quick actions: 2×2 cards, each one clickable as a whole.
		rightCol.createDiv({ cls: "ds-block-title" }).createSpan({ text: "快速开始" });
		const actions = rightCol.createDiv({ cls: "ds-action-grid" });
		this.actionCard(actions, "＋", "添加资料", "PDF / PPT / Word / 图片", () => this.plugin.importMaterial(), true);
		// The six actions the spec names, not a Ctrl+P command: 拍手写 is a core
		// entry point, so it is a card on Today.
		this.actionCard(actions, "✎", "拍手写笔记", "拍照或选图片，自动识别文字", () => this.plugin.importHandwriting(true));
		this.actionCard(actions, "AI", "问 AI", "基于你的资料回答", () => this.plugin.ask("all"));
		this.actionCard(actions, "✓", "考我", "快速开始练习", () => this.plugin.generateQuiz());
		this.actionCard(actions, "↻", "复习", "处理待复习内容", () => this.plugin.createReview());

		// One overview card with an internal 2×2, instead of six equal tiles
		// stretched across the page.
		const overview = rightCol.createDiv({ cls: "ds-card" });
		overview.createDiv({ cls: "ds-block-title" }).createSpan({ text: "学习概览" });
		const grid = overview.createDiv({ cls: "ds-overview-grid" });
		this.stat(grid, "待复习", String(weakList.length), weakList.length === 0);
		this.stat(grid, "薄弱点", String(stats.weak_points_open || 0), !stats.weak_points_open);
		this.stat(grid, "资料", String(mats.ready || 0), !mats.ready);
		this.stat(grid, "答题记录", String(attempts.count || 0), !attempts.count);
	}

	/** The phone's six entry points, each one a whole tappable tile. */
	renderMobileActions(root, active, tasks, goal) {
		const grid = root.createDiv({ cls: "ds-mobile-actions" });
		for (const action of MOBILE_ACTIONS) {
			const tile = grid.createEl("button", { cls: "ds-mobile-action" });
			tile.createDiv({ cls: "ds-action-icon", text: action.icon });
			tile.createDiv({ cls: "ds-action-title", text: action.title });
			tile.createDiv({ cls: "ds-action-desc", text: action.desc });
			tile.addEventListener("click", () =>
				this.plugin.guarded(action.title, async () => {
					if (action.run === "today") {
						await this.setSection("today");
						this.scrollToPlan();
						return;
					}
					if (action.run === "continue") {
						if (!tasks.length) {
							new Notice(goal ? "今天还没有要学的内容。" : "请先创建学习目标。", 6000);
							return;
						}
						await this.startSession();
						return;
					}
					if (action.run === "photo") return this.plugin.importHandwriting(true);
					if (action.run === "ask") return this.plugin.ask("all");
					if (action.run === "quiz") return this.openQuizDuration();
					if (action.run === "review") return this.setSection("review");
				}),
			);
		}
		// 继续学习 is the one that most often has nothing to do, so it says so
		// rather than looking available and refusing.
		if (!tasks.length) {
			const tiles = grid.children || [];
			if (tiles[1]) tiles[1].addClass("is-muted");
		}
	}

	scrollToPlan() {
		const target = this.contentEl.querySelector(".ds-block-title");
		if (target && target.scrollIntoView) target.scrollIntoView({ behavior: "smooth", block: "start" });
	}

	/**
	 * Today's budget, and the only control that changes it.
	 *
	 * Changing the length re-plans the day immediately (the server does it in the
	 * same request), which is why this is a row of one-tap choices rather than a
	 * setting somewhere else in the app.
	 */
	renderMinutesPicker(root, goal) {
		const bar = root.createDiv({ cls: "ds-minutes" });
		bar.createDiv({ cls: "ds-minutes-label", text: "今天想学多久" });
		const row = bar.createDiv({ cls: "ds-minutes-row" });
		const current = goal.daily_minutes || 60;
		for (const minutes of [30, 45, 60, 90, 120]) {
			const chip = row.createEl("button", {
				cls: "ds-chip" + (minutes === current ? " is-active" : ""),
				text: minutes + " 分钟",
			});
			chip.addEventListener("click", () =>
				this.plugin.guarded("调整学习时长", () => this.setMinutes(minutes)),
			);
		}
		const custom = row.createEl("button", {
			cls: "ds-chip",
			text: [30, 45, 60, 90, 120].includes(current) ? "自定义" : current + " 分钟",
		});
		custom.addEventListener("click", () => {
			const holder = bar.createDiv({ cls: "ds-minutes-custom" });
			const input = holder.createEl("input", { type: "number", cls: "ds-input" });
			input.min = "5";
			input.max = "600";
			input.value = String(current);
			// An inline field rather than window.prompt: prompt is unavailable in
			// some mobile WebViews, and a silent no-op is worse than a visible field.
			this.button(
				holder,
				"确定",
				async () => {
					const value = Math.round(Number(input.value));
					if (!Number.isFinite(value) || value < 5 || value > 600) {
						throw new Error("请输入 5 到 600 之间的分钟数。");
					}
					await this.setMinutes(value);
				},
				"primary",
			);
			input.focus();
		});
	}

	async setMinutes(minutes) {
		const goal = this.state.data && this.state.data.goal;
		if (!goal) throw new Error("请先创建学习目标。");
		const res = await this.plugin.api("/goals/" + goal.id + "/minutes", {
			method: "POST",
			body: { minutes: minutes },
		});
		if (!res.ok) throw new Error(res.error || "无法调整今天的学习时长。");
		this.state.status = "loading";
		await this.render();
	}

	/** One planned task, with the reason it is on today's list. */
	taskRow(container, task) {
		const row = container.createDiv({
			cls: "ds-row ds-task" + (task.status === "done" ? " is-done" : ""),
		});
		const main = row.createDiv({ cls: "ds-row-main" });
		main.createDiv({ cls: "ds-row-title", text: task.title || "学习任务" });
		const bits = [];
		if (task.course) bits.push(task.course);
		if (task.planned_minutes) bits.push(task.planned_minutes + " 分钟");
		if (task.module) bits.push(task.module);
		if (bits.length) main.createDiv({ cls: "ds-row-meta", text: bits.join(" · ") });
		if (task.reason) main.createDiv({ cls: "ds-row-reason", text: "为什么： " + task.reason });
		if (task.detail) main.createDiv({ cls: "ds-row-detail", text: task.detail });

		const side = row.createDiv({ cls: "ds-row-side" });
		side.createDiv({
			cls:
				"ds-pill" +
				(task.status === "done" ? "" : task.status === "skipped" ? " ds-pill-muted" : " ds-pill-warn"),
			text: task.status === "done" ? "已完成" : task.status === "skipped" ? "已跳过" : "待完成",
		});
		if (task.status === "pending") {
			const go = side.createEl("button", { cls: "ds-btn ds-btn-ghost", text: "现在做" });
			go.addEventListener("click", () => this.plugin.guarded("开始学习", () => this.startSession()));
		}
	}

	async startSession() {
		const res = await this.plugin.api("/runs", { method: "POST", body: {} });
		if (!res.ok) throw new Error(res.error || "无法开始学习。");
		// Re-read on close: a finished session changes today's counts, and a
		// partly-finished one changes which step is current.
		new StudySessionModal(this.app, this.plugin, res.data, () => this.reload()).open();
	}

	actionCard(parent, icon, title, desc, onClick, primary) {
		const el = parent.createEl("button", { cls: "ds-action" + (primary ? " is-primary" : "") });
		el.createDiv({ cls: "ds-action-icon", text: icon });
		el.createDiv({ cls: "ds-action-title", text: title });
		el.createDiv({ cls: "ds-action-desc", text: desc });
		el.addEventListener("click", () => this.plugin.guarded(title, onClick));
		return el;
	}

	stat(parent, label, value, muted) {
		const box = parent.createDiv();
		box.createDiv({ cls: "ds-stat-label", text: label });
		box.createDiv({ cls: "ds-stat-value" + (muted ? " ds-muted-value" : ""), text: value });
		return box;
	}

	materialRow(container, m) {
		const row = container.createDiv({ cls: "ds-mat" });
		const ext = String(m.material_type || m.ext || "").replace(".", "").toUpperCase();
		row.createDiv({ cls: "ds-mat-icon", text: ext ? ext.slice(0, 3) : "•" });

		const main = row.createDiv({ cls: "ds-mat-main" });
		main.createDiv({ cls: "ds-mat-title", text: m.title || m.filename || "(未命名)" });
		// How the material is structured is the first thing that decides whether
		// it is usable for daily study, so it belongs in the row, not a detail page.
		const bits = [ext || "未知类型", (m.char_count || 0).toLocaleString() + " 字"];
		if (m.unit_count && m.unit_count > 1) bits.push(m.unit_count + " 个部分");
		else if (m.unit_count === 1) bits.push("未分节");
		if (m.course) bits.unshift(m.course);
		if (m.created_at) bits.push("导入于 " + String(m.created_at).slice(0, 10));
		main.createDiv({ cls: "ds-mat-meta", text: bits.join(" · ") });

		const side = row.createDiv({ cls: "ds-mat-side" });
		const status = m.processing_status;
		side.createDiv({
			cls:
				"ds-pill" +
				(status === "ready" ? "" : status === "failed" ? " ds-pill-warn" : " ds-pill-muted"),
			text: status === "ready" ? "已就绪" : status === "failed" ? "处理失败" : "处理中",
		});

		if (!m.course) {
			// "（未归类）" used to be the loudest thing on the page for an
			// unclassified material. Offer the fix rather than the verdict.
			side.createDiv({ cls: "ds-pill ds-pill-warn", text: "尚未分配课程" });
			// A guess is offered next to the fix, never instead of it: the dialog
			// opens pre-filled so accepting is one click and ignoring costs nothing.
			if (m.suggested_course) {
				main.createDiv({
					cls: "ds-row-reason",
					text: "可能是「" + m.suggested_course + "」 · " + (m.suggested_reason || ""),
				});
			}
			const assign = side.createEl("button", { cls: "ds-btn ds-btn-ghost", text: "分配课程" });
			assign.addEventListener("click", () =>
				this.plugin.guarded("分配课程", async () => {
					new CourseModal(this.app, this.plugin, {
						id: m.id,
						title: m.title,
						course: m.course || m.suggested_course || "",
					}).open();
				}),
			);
		}

		const open = side.createEl("button", { cls: "ds-btn ds-btn-ghost", text: "打开" });
		open.addEventListener("click", () =>
			this.plugin.guarded("打开资料", async () => {
				const res = await this.plugin.api("/materials/" + m.id + "/note");
				if (!res.ok) throw new Error(res.error);
				await this.plugin.writeNote(res.data.note_path, res.data.note_content, true);
				await this.plugin.openNote(res.data.note_path);
			}),
		);

		// One request answers both "what is it made of" and "have I saved this
		// twice": the single-material read carries the units and any resemblance.
		if ((m.unit_count || 0) > 0 || m.processing_status === "ready") {
			const parts = side.createEl("button", { cls: "ds-btn ds-btn-ghost", text: "看内容" });
			parts.addEventListener("click", () =>
				this.plugin.guarded("查看材料内容", async () => {
					const existing = row.querySelector(".ds-mat-parts");
					if (existing) {
						existing.remove();
						return;
					}
					const res = await this.plugin.api("/materials/" + m.id);
					if (!res.ok) throw new Error(res.error || "读不到这份资料。");
					this.renderMaterialParts(row, res.data);
				}),
			);
		}
		return row;
	}

	/**
	 * The parts of a material, each one startable on its own, plus any other
	 * material that looks like it.
	 *
	 * A resemblance is stated and left there: nothing is hidden, merged or
	 * deleted because two documents look alike (§17).
	 */
	renderMaterialParts(row, material) {
		const box = row.createDiv({ cls: "ds-mat-parts" });
		const units = material.units || [];
		if (units.length > 1) {
			box.createDiv({
				cls: "ds-parts-title",
				text: "这份资料有 " + units.length + " 个部分，可以只学其中一个：",
			});
			for (const unit of units) {
				const line = box.createDiv({ cls: "ds-part" });
				const main = line.createDiv({ cls: "ds-part-main" });
				main.createDiv({ cls: "ds-part-name", text: unit.title });
				const meta = [];
				if (unit.page_start && unit.page_end && unit.page_start !== unit.page_end) {
					meta.push("第 " + unit.page_start + "–" + unit.page_end + " 页");
				} else if (unit.page_start) {
					meta.push("第 " + unit.page_start + " 页");
				}
				if (unit.char_count) meta.push(unit.char_count.toLocaleString() + " 字");
				if (meta.length) main.createDiv({ cls: "ds-part-meta", text: meta.join(" · ") });

				const go = line.createEl("button", { cls: "ds-btn ds-btn-primary", text: "学这个部分" });
				go.addEventListener("click", () =>
					this.plugin.guarded("学这个部分", () => this.startUnit(unit.id)),
				);
			}
		} else if (units.length === 1) {
			box.createDiv({ cls: "ds-parts-title", text: "这份资料没有分节，整篇就是一个学习单元。" });
		}

		// Only offered for a page that was read by OCR, because re-flowing a
		// parsed document would be pointless — and the wording says exactly what
		// it will and will not do.
		if ((material.imported_from || "") === "handwriting") {
			const tidyRow = box.createDiv({ cls: "ds-inline" });
			tidyRow.createDiv({
				cls: "ds-subtle",
				text: "这段文字是 OCR 识别的原文，标着" + "[识别不确定]" + "的地方机器没有把握。",
			});
			const tidy = tidyRow.createEl("button", { cls: "ds-btn ds-btn-ghost", text: "AI 整理排版" });
			tidy.addEventListener("click", () =>
				this.plugin.guarded("AI 整理", () => this.plugin.tidyMaterial(material.id)),
			);
		}

		for (const other of material.similar || []) {
			const warn = box.createDiv({ cls: "ds-similar" });
			warn.createDiv({
				cls: "ds-similar-title",
				text: "这份资料可能和「" + (other.title || "另一份资料") + "」很相似",
			});
			warn.createDiv({
				cls: "ds-similar-body",
				text: (other.reason || "") + "。两份都保留，是否留下由你决定。",
			});
			const acts = warn.createDiv({ cls: "ds-inline" });
			const look = acts.createEl("button", { cls: "ds-btn ds-btn-ghost", text: "看看那一份" });
			look.addEventListener("click", () =>
				this.plugin.guarded("打开相似的资料", async () => {
					const res = await this.plugin.api("/materials/" + other.id + "/note");
					if (!res.ok) throw new Error(res.error || "读不到那份资料。");
					await this.plugin.writeNote(res.data.note_path, res.data.note_content, true);
					await this.plugin.openNote(res.data.note_path);
				}),
			);
		}
		return box;
	}

	/** Open a session that begins at one part of a material. */
	async startUnit(unitId) {
		const res = await this.plugin.api("/units/" + unitId + "/study", { method: "POST", body: {} });
		if (!res.ok) throw new Error(res.error || "无法开始学习这个部分。");
		new StudySessionModal(this.app, this.plugin, res.data, () => this.reload()).open();
	}

	renderCourses(root, data) {
		const byCourse = (data.progress && data.progress.by_course) || [];
		root.createDiv({ cls: "ds-h2", text: "课程" });
		if (!byCourse.length) {
			root.createDiv({ cls: "ds-empty", text: "还没有课程。添加资料时指定课程，这里就会出现。" });
			const actions = root.createDiv({ cls: "ds-actions" });
			this.button(actions, "+ 添加资料", () => this.plugin.importMaterial(), "primary");
			return;
		}
		const list = root.createDiv({ cls: "ds-list" });
		for (const c of byCourse) {
			const row = list.createDiv({ cls: "ds-row" });
			const main = row.createDiv({ cls: "ds-row-main" });
			main.createDiv({ cls: "ds-row-title", text: c.course });
			main.createDiv({ cls: "ds-row-meta", text: c.materials + " 份资料 · " + (c.chars || 0).toLocaleString() + " 字" });
			const side = row.createDiv({ cls: "ds-row-side" });
			this.button(side, "问这门课", () => this.plugin.ask("course", c.course), "ghost");
		}
		// Not a note about work not done: a list of where the things a person would
		// look for here actually live. The product telling the user that a page
		// "will be provided in a later phase" is the product apologising for itself,
		// which is the last thing a page should say to somebody already unsure
		// whether it is worth using.
		root.createDiv({
			cls: "ds-note",
			text: "每门课的份数和字数就在上面。改资料的归属：到「资料」页点「分配课程」；"
				+ "考试倒计时在「今天」；各目标进度在「进度」。",
		});
	}

	renderMaterials(root, data) {
		root.createDiv({ cls: "ds-h2", text: "资料" });
		const actions = root.createDiv({ cls: "ds-actions" });
		this.button(actions, "+ 添加资料", () => this.plugin.importMaterial(), "primary");
		this.button(actions, "拍手写笔记", () => this.plugin.importHandwriting(true), "ghost");
		this.button(actions, "从相册选", () => this.plugin.importHandwriting(false), "ghost");

		if (!data.materials.length) {
			root.createDiv({ cls: "ds-empty", text: "还没有资料。点「+ 添加资料」导入 PDF / PPT / Word / 图片。" });
			return;
		}

		// Anything without a course is the one thing that blocks the planner, so
		// it is surfaced as work to do rather than left as a label in a list.
		const unassigned = data.materials.filter((m) => !m.course);
		if (unassigned.length) {
			const box = root.createDiv({ cls: "ds-minutes" });
			box.createDiv({
				cls: "ds-minutes-label",
				text: "有 " + unassigned.length + " 份资料还没有课程，暂时不会进入每天的计划",
			});
		}

		const list = root.createDiv({ cls: "ds-list" });
		for (const m of data.materials) this.materialRow(list, m);
	}

	/**
	 * 复习：薄弱点、待复习、已掌握 —— in the user's words.
	 *
	 * The weak-point rule is stated on the page rather than only enforced in the
	 * database, because "one wrong answer did not create a weakness" is a promise
	 * the user needs to be able to see. No engineering vocabulary appears here:
	 * no Assessment, no Attempt, no weak-point id.
	 */
	renderReview(root, data) {
		const weak = data.weakPoints || [];
		const progress = data.progress || {};
		const weakStats = progress.weak_points || {};
		const mastered = weakStats.closed || 0;
		// The streak length comes from the server, so the page states the rule it
		// actually enforces rather than a number this file happens to know.
		const streak = weakStats.mastered_streak || 3;

		root.createDiv({ cls: "ds-h2", text: "复习" });

		const grid = root.createDiv({ cls: "ds-grid" });
		this.card(grid, "薄弱点", String(weak.length), "反复出错的题目");
		this.card(grid, "已掌握", String(mastered), "连续答对 " + streak + " 次后关闭");
		this.card(
			grid,
			"掌握进度",
			weak.length + mastered ? (weakStats.closure_rate_percent || 0) + "%" : "—",
			"已掌握 / 共有过",
		);
		this.card(
			grid,
			"错一次",
			String(weakStats.single_slips || 0),
			"记录下来了，还不算薄弱点",
		);

		const actions = root.createDiv({ cls: "ds-actions" });
		this.button(actions, "考我", () => this.openQuizDuration(), "primary");
		this.button(actions, "生成复习清单", () => this.plugin.createReview());
		this.button(actions, "问 AI", () => this.plugin.ask("all"), "ghost");

		// The rule, in one line, where it matters.
		root.createDiv({
			cls: "ds-subtle",
			text: "偶尔错一次不会变成薄弱点，只有重复出错才会；薄弱点要连续答对 " + streak + " 次才算掌握，机器不会替你判断。",
		});

		if (weak.length) {
			const title = root.createDiv({ cls: "ds-block-title" });
			title.createSpan({ text: "反复出错，需要再练" });
			title.createSpan({ cls: "ds-count", text: weak.length + " 题" });
			const list = root.createDiv({ cls: "ds-list" });
			for (const item of weak.slice(0, 20)) {
				const row = list.createDiv({ cls: "ds-row" });
				const main = row.createDiv({ cls: "ds-row-main" });
				main.createDiv({ cls: "ds-row-title", text: item.question_text || "(题目)" });
				const bits = [];
				if (item.course) bits.push(item.course);
				if (item.material_title) bits.push(item.material_title);
				bits.push("错过 " + (item.times_wrong || 0) + " 次");
				if (item.times_correct) bits.push("答对 " + item.times_correct + " 次");
				main.createDiv({ cls: "ds-row-meta", text: bits.join(" · ") });
				main.createDiv({ cls: "ds-row-reason", text: "需要连续答对 " + streak + " 次才算掌握" });
				row.createDiv({ cls: "ds-row-side" }).createDiv({ cls: "ds-pill ds-pill-warn", text: "待复习" });
			}
		} else {
			root
				.createDiv({ cls: "ds-empty" })
				.createDiv({ cls: "ds-empty-body", text: "目前没有反复出错的题。可以点「考我」练一练。" });
		}
	}

	/**
	 * How long to practise, then go.
	 *
	 * The choice is the same shape as the day's length on Today, because it is
	 * the same kind of decision and should not need learning twice.
	 */
	openQuizDuration() {
		new QuizDurationModal(this.app, this.plugin, () => this.reload()).open();
	}

	renderProgress(root, data) {
		const p = data.progress || {};
		const detail = data.progressDetail || {};
		const week = detail.week || {};
		const change = detail.weak_point_change || {};
		const weak = p.weak_points || {};

		root.createDiv({ cls: "ds-h2", text: "进度" });

		// The six things worth looking at, and nothing else by default.
		const grid = root.createDiv({ cls: "ds-grid" });
		this.card(grid, "本周学习时间", (week.minutes || 0) + " 分钟", "本周一到今天");
		this.card(
			grid,
			"计划完成率",
			(week.completion_rate_percent || 0) + "%",
			(week.tasks_done || 0) + " / " + (week.tasks_total || 0) + " 项",
		);
		this.card(
			grid,
			"薄弱点变化",
			(change.net > 0 ? "+" : "") + (change.net || 0),
			"新出现 " + (change.opened || 0) + " · 掌握 " + (change.closed || 0),
		);
		this.card(
			grid,
			"已掌握",
			String(weak.closed || 0),
			"还有 " + (weak.open || 0) + " 个需要练",
		);
		const best = (detail.most_improved || [])[0];
		this.card(
			grid,
			"提升最多",
			best ? best.course : "—",
			best ? "正确率 " + best.from_percent + "% → " + best.to_percent + "%" : "还没有足够记录",
		);
		const attention = (detail.needs_attention || [])[0];
		this.card(grid, "最需要关注", attention ? this.attentionLabel(attention) : "—", attention ? attention.text : "");

		// Goals, each with a pace statement rather than a predicted score.
		const goals = detail.goals || [];
		if (goals.length) {
			root.createDiv({ cls: "ds-block-title" }).createSpan({ text: "各目标进度" });
			const list = root.createDiv({ cls: "ds-list" });
			for (const goal of goals) {
				const row = list.createDiv({ cls: "ds-row" });
				const main = row.createDiv({ cls: "ds-row-main" });
				main.createDiv({ cls: "ds-row-title", text: goal.title });
				const bits = [];
				if (goal.days_to_exam !== null && goal.days_to_exam !== undefined) {
					bits.push("距离考试 " + goal.days_to_exam + " 天");
				}
				bits.push("完成 " + goal.completion_rate_percent + "%");
				bits.push("已学 " + goal.minutes_done + " 分钟");
				main.createDiv({ cls: "ds-row-meta", text: bits.join(" · ") });
				main.createDiv({ cls: "ds-row-reason", text: this.paceText(goal.pace) });
				row.createDiv({ cls: "ds-row-side" }).createDiv({
					cls: "ds-pill" + (goal.pace && goal.pace.on_track === false ? " ds-pill-warn" : ""),
					text: goal.pace && goal.pace.on_track === false ? "偏慢" : "正常",
				});
			}
		}

		// Trends are available, but folded away: the summary is the point.
		const trend = detail.trend || [];
		if (trend.length) {
			const box = root.createDiv({ cls: "ds-card" });
			const head = box.createDiv({ cls: "ds-block-title" });
			head.createSpan({ text: "详细趋势" });
			const more = box.createDiv();
			more.style.display = "none";
			for (const point of trend.slice(-14)) {
				const line = more.createDiv({ cls: "ds-row-meta" });
				line.setText(point.day + " · " + point.attempts + " 次 · 平均 " + point.avg_score + "%");
			}
			const toggle = box.createEl("button", { cls: "ds-btn ds-btn-ghost", text: "展开详细趋势" });
			let open = false;
			toggle.addEventListener("click", () => {
				open = !open;
				more.style.display = open ? "block" : "none";
				toggle.setText(open ? "收起详细趋势" : "展开详细趋势");
			});
		}

		if (detail.note) root.createDiv({ cls: "ds-subtle", text: detail.note });
	}

	/** What kind of thing needs attention, in the user's words. */
	attentionLabel(item) {
		if (item.kind === "weak_points") return "反复出错的题";
		if (item.kind === "skipped") return "被跳过的计划";
		if (item.kind === "declining") return "正确率在下降";
		return "暂时没有";
	}

	/**
	 * A pace statement, not a forecast.
	 *
	 * The spec allows "at this rate, will this finish?" and forbids predicting an
	 * exam result, so this sentence deliberately stops at the study rate.
	 */
	paceText(pace) {
		if (!pace) return "";
		const target = pace.target_minutes_per_day || 0;
		if (pace.recent_minutes_per_active_day === 0) {
			return "最近还没有学习记录，按计划是每天 " + target + " 分钟。";
		}
		const trend = pace.on_track
			? "达到计划的每天 " + target + " 分钟"
			: "低于计划的每天 " + target + " 分钟";
		return "最近平均每次 " + pace.recent_minutes_per_active_day + " 分钟，" + trend + "。";
	}

	renderFiles(root) {
		root.createDiv({ cls: "ds-h2", text: "高级 / 文件库" });
		const box = root.createDiv({ cls: "ds-banner" });
		box.createDiv({
			text: this.plugin.settings.dailyMode
				? "当前是日常模式：文件树、Ribbon、Properties 已隐藏，但内容完整保留。"
				: "当前是高级模式：工程视图已恢复。",
		});
		this.button(
			box,
			this.plugin.settings.dailyMode ? "开启高级模式" : "回到日常模式",
			() => this.plugin.setDailyMode(!this.plugin.settings.dailyMode, true),
			"primary",
		);

		root.createDiv({ cls: "ds-h2", text: "工程目录" });
		const folders = [
			["00 Inbox", "收件箱与临时笔记"],
			["01 Courses", "课程笔记"],
			["02 Knowledge", "知识点"],
			["03 Review", "薄弱点与复习"],
			["04 Projects", "长期项目"],
			["05 Archive", "归档"],
			["06 Materials", "材料笔记"],
			["07 Assessments", "测验"],
			["08 Plan", "计划与进度"],
			["90 Templates", "模板"],
			["99 Attachments", "附件"],
		];
		const grid = root.createDiv({ cls: "ds-folders" });
		for (const [name, desc] of folders) {
			const item = grid.createEl("button", { cls: "ds-folder", text: name });
			item.createEl("small", { text: desc });
			item.addEventListener("click", () => this.plugin.guarded("打开文件夹", () => this.openFolder(name)));
		}

		root.createDiv({ cls: "ds-h2", text: "维护" });
		const tools = root.createDiv({ cls: "ds-actions" });
		this.button(tools, "打开 DANIEL STUDY 首页", () => this.plugin.openNote("DANIEL STUDY.md"));
		this.button(tools, "插件设置", () => {
			if (!this.app.setting) throw new Error("这个版本的 Obsidian 没有暴露设置面板入口，请用 设置 → 第三方插件 → Daniel Study。");
			this.app.setting.open();
			this.app.setting.openTabById("daniel-study");
		}, "ghost");
		this.button(tools, "同步服务器内容", () => this.plugin.syncServerNotes(), "ghost");
		this.button(tools, "测试连接", () => this.plugin.testConnection(), "ghost");
	}
}

module.exports = DanielStudyPlugin;
