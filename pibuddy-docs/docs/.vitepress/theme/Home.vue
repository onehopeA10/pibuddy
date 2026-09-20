<script setup lang="ts">
import { computed } from 'vue'
import { useData } from 'vitepress'

// 首页随语言切换文案与链接前缀；中文为 root，英文为 /en
const { lang } = useData()
const isEn = computed(() => lang.value.startsWith('en'))
const prefix = computed(() => (isEn.value ? '/en' : ''))

const copy = computed(() =>
  isEn.value
    ? {
        badge: 'PiBuddy · Desktop Agent',
        title: 'Read the product as a system.',
        lead: 'A calm, inspectable desktop workspace for office work with AI. Follow the boundaries, understand the contracts, and make changes with context.',
        start: 'Start here →',
        architecture: 'Read the architecture',
        topology: 'Runtime topology',
        topologyCaption: 'pi protocol v1 · backup schema v1 · inspectable by default',
        statement: 'This is not a file dump. It is a map for locating, understanding, changing, and validating the system. Start with the question you are solving.',
        journeysEyebrow: 'Four journeys. One readable thread.',
        boundariesEyebrow: 'Four boundaries. Each has an owner.',
        versionEyebrow: 'The line this documentation describes',
        versionNoteBefore: 'Stack: Electron + Vue 3 + Pinia + Naive UI + electron-vite + electron-builder. Build context with the ',
        versionNoteLink: 'guide',
        versionNoteAfter: ', or open the full specification index.',
        versionLang: 'EN / 中文',
        shotAlt: 'PiBuddy on a laptop',
      }
    : {
        badge: 'PiBuddy · 桌面 Agent',
        title: '把产品当作一个系统来阅读。',
        lead: '一个可检视、边界清晰的桌面工作台，让办公用户用 AI 完成日常工作。跟随边界、理解契约，带着上下文做改动。',
        start: '从这里开始 →',
        architecture: '阅读架构',
        topology: '运行时拓扑',
        topologyCaption: 'pi 协议 v1 · 备份 schema v1 · 默认可检视',
        statement: '这不是文件堆叠，而是一张用于定位、理解、改动与验证系统的地图。从你要解决的问题出发。',
        journeysEyebrow: '四段旅程，一条可读的主线',
        boundariesEyebrow: '四条边界，各有归属',
        versionEyebrow: '这份文档描述的产品线',
        versionNoteBefore: '技术栈 Electron + Vue 3 + Pinia + Naive UI + electron-vite + electron-builder。用',
        versionNoteLink: '指南',
        versionNoteAfter: '建立上下文，或直接打开完整规格索引。',
        versionLang: '中文 / EN',
        shotAlt: '笔记本上的 PiBuddy',
      },
)

const topology = computed(() =>
  isEn.value
    ? [
        { no: '01', name: 'Renderer', role: 'Presentation', desc: 'Vue 3 + Pinia + Naive UI. Presentation only; state is normalized by sessionId.' },
        { no: '02', name: 'Preload', role: 'Capability bridge', desc: 'Narrow APIs under contextIsolation: verifiable, revocable product actions.' },
        { no: '03', name: 'Electron Main', role: 'Host authority', desc: 'Processes, permissions, secrets, files, Git, terminal, updates, and persistence.' },
        { no: '04', name: 'pi sidecar', role: 'Agent runtime', desc: 'JSONL over stdio, replaceable; default is the bundled Pi shipped with the app.' },
        { no: '05', name: 'SQLite', role: 'Durable state', desc: 'Twelve capability-partitioned databases; per-database consistency, backup, and restore.' },
      ]
    : [
        { no: '01', name: 'Renderer', role: '表现层', desc: 'Vue 3 + Pinia + Naive UI，只做呈现，按 sessionId 归一状态' },
        { no: '02', name: 'Preload', role: '能力桥', desc: 'contextIsolation 下的窄接口，暴露可验证、可撤销的业务动作' },
        { no: '03', name: 'Electron Main', role: '主进程权威', desc: '进程、权限、密钥、文件、Git、终端、更新与持久化' },
        { no: '04', name: 'pi sidecar', role: 'Agent 运行时', desc: 'JSONL over stdio，可替换；默认使用随应用发布的 bundled Pi' },
        { no: '05', name: 'SQLite', role: '持久状态', desc: '按能力域分区在 12 个独立库，逐库一致、可备份可恢复' },
      ],
)

const principles = computed(() =>
  isEn.value
    ? [
        { title: 'Locate the boundary', desc: 'Start from product intent, then move through architecture, runtime, UX, security, delivery, and extensions.' },
        { title: 'Read the contract', desc: 'Follow @pibuddy/contract as the single source of truth, plus pi-sdk, JSONL RPC, and storage ownership.' },
        { title: 'Change with evidence', desc: 'Connect the relevant spec, decision, implementation, tests, and release checklist.' },
      ]
    : [
        { title: '定位边界', desc: '从产品意图出发，穿过架构、运行时、UX、安全、交付与扩展。' },
        { title: '阅读契约', desc: '跟随 @pibuddy/contract 唯一真相源、pi-sdk、JSONL RPC 与存储归属。' },
        { title: '带着证据改动', desc: '把相关规格、决策、实现、测试与发布清单连成一条线。' },
      ],
)

const journeys = computed(() =>
  isEn.value
    ? [
        { no: '01', tag: 'ORIENT', title: 'Build the product model', desc: 'Know what is shipped and what is deliberately out of scope.', link: '/guide/product-scope' },
        { no: '02', tag: 'TRACE', title: 'Trace one request', desc: 'Follow Renderer → Preload → Main → pi → SQLite across the five hops.', link: '/architecture/event-flow' },
        { no: '03', tag: 'EXTEND', title: 'Build a capability pack', desc: 'From manifest to resource materialization, permission gates, and lifecycle.', link: '/extensions/' },
        { no: '04', tag: 'SHIP', title: 'Validate a change', desc: 'Connect the spec, implementation, test scenario, and delivery record.', link: '/delivery/' },
      ]
    : [
        { no: '01', tag: 'ORIENT', title: '建立产品模型', desc: '弄清已交付什么、刻意不做什么。', link: '/guide/product-scope' },
        { no: '02', tag: 'TRACE', title: '追踪一次请求', desc: '沿 Renderer → Preload → Main → pi → SQLite 的五跳事件流。', link: '/architecture/event-flow' },
        { no: '03', tag: 'EXTEND', title: '构建能力包', desc: '从 manifest 到资源物化、权限闸与生命周期。', link: '/extensions/' },
        { no: '04', tag: 'SHIP', title: '验证一次改动', desc: '连接规格、实现、测试场景与发布记录。', link: '/delivery/' },
      ],
)

const boundaries = computed(() =>
  isEn.value
    ? [
        { no: '01', name: 'Renderer', kind: 'Presentation', desc: 'Vue components, Pinia stores, event reduction, and virtual scrolling.', link: '/architecture/' },
        { no: '02', name: 'Main', kind: 'Authority', desc: 'Permission center, process supervision, secret custody, and atomic persistence.', link: '/security/' },
        { no: '03', name: 'pi', kind: 'Runtime', desc: 'Agent loop, tools, context, and provider-facing model work.', link: '/runtime/' },
        { no: '04', name: 'SQLite', kind: 'State', desc: 'Sessions, settings, tasks, memory, and workspaces — partitioned by domain.', link: '/data/' },
      ]
    : [
        { no: '01', name: 'Renderer', kind: '表现', desc: 'Vue 组件、Pinia store、事件归约与虚拟滚动。', link: '/architecture/' },
        { no: '02', name: 'Main', kind: '权威', desc: '权限中心、进程监督、密钥保管与原子持久化。', link: '/security/' },
        { no: '03', name: 'pi', kind: '运行时', desc: 'Agent 循环、工具、上下文与 provider 模型工作。', link: '/runtime/' },
        { no: '04', name: 'SQLite', kind: '状态', desc: '会话、配置、任务、记忆与工作区，逐库分区归属。', link: '/data/' },
      ],
)

const versionLine = computed(() =>
  isEn.value
    ? [
        { label: 'Application', value: '0.1.0' },
        { label: 'pi protocol', value: 'v1' },
        { label: 'Backup schema', value: 'v1' },
        { label: 'Languages', value: copy.value.versionLang },
      ]
    : [
        { label: '应用版本', value: '0.1.0' },
        { label: 'pi 线协议', value: 'v1' },
        { label: '备份 schema', value: 'v1' },
        { label: '文档语言', value: copy.value.versionLang },
      ],
)
</script>

<template>
  <div class="pb-home">
    <section class="pb-hero">
      <div class="pb-hero__badge">{{ copy.badge }}</div>
      <h1 class="pb-hero__title">{{ copy.title }}</h1>
      <p class="pb-hero__lead">{{ copy.lead }}</p>
      <div class="pb-hero__actions">
        <a class="pb-btn pb-btn--primary" :href="`${prefix}/guide/`">{{ copy.start }}</a>
        <a class="pb-btn" :href="`${prefix}/architecture/`">{{ copy.architecture }}</a>
      </div>
      <a class="pb-hero__shot" :href="`${prefix}/screens/`">
        <img src="/screens/hero-laptop.png" :alt="copy.shotAlt" />
      </a>
    </section>

    <section class="pb-section">
      <div class="pb-eyebrow">{{ copy.topology }}</div>
      <div class="pb-topology">
        <div v-for="layer in topology" :key="layer.no" class="pb-layer">
          <span class="pb-layer__no">{{ layer.no }}</span>
          <div class="pb-layer__body">
            <div class="pb-layer__head">
              <strong>{{ layer.name }}</strong>
              <span class="pb-layer__role">{{ layer.role }}</span>
            </div>
            <p class="pb-layer__desc">{{ layer.desc }}</p>
          </div>
        </div>
      </div>
      <div class="pb-topology__caption">{{ copy.topologyCaption }}</div>
    </section>

    <section class="pb-section">
      <div class="pb-principles">
        <div v-for="p in principles" :key="p.title" class="pb-principle">
          <h3>{{ p.title }}</h3>
          <p>{{ p.desc }}</p>
        </div>
      </div>
      <p class="pb-statement">{{ copy.statement }}</p>
    </section>

    <section class="pb-section">
      <div class="pb-eyebrow">{{ copy.journeysEyebrow }}</div>
      <div class="pb-journeys">
        <a v-for="j in journeys" :key="j.no" class="pb-journey" :href="`${prefix}${j.link}`">
          <div class="pb-journey__top">
            <span class="pb-journey__no">{{ j.no }}</span>
            <span class="pb-journey__tag">{{ j.tag }}</span>
          </div>
          <h3>{{ j.title }}</h3>
          <p>{{ j.desc }}</p>
          <span class="pb-journey__arrow">↗</span>
        </a>
      </div>
    </section>

    <section class="pb-section">
      <div class="pb-eyebrow">{{ copy.boundariesEyebrow }}</div>
      <div class="pb-boundaries">
        <a v-for="b in boundaries" :key="b.no" class="pb-boundary" :href="`${prefix}${b.link}`">
          <div class="pb-boundary__no">{{ b.no }}</div>
          <div class="pb-boundary__meta">
            <strong>{{ b.name }}</strong>
            <span>{{ b.kind }}</span>
          </div>
          <p>{{ b.desc }}</p>
        </a>
      </div>
    </section>

    <section class="pb-section pb-versionline">
      <div class="pb-eyebrow">{{ copy.versionEyebrow }}</div>
      <div class="pb-versions">
        <div v-for="v in versionLine" :key="v.label" class="pb-version">
          <span class="pb-version__label">{{ v.label }}</span>
          <span class="pb-version__value">{{ v.value }}</span>
        </div>
      </div>
      <p class="pb-versionline__note">
        {{ copy.versionNoteBefore }}<a :href="`${prefix}/guide/`">{{ copy.versionNoteLink }}</a>{{ copy.versionNoteAfter }}
      </p>
    </section>
  </div>
</template>
