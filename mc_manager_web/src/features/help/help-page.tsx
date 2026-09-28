/**
 * HelpPage —— 站内使用向导（`/help`）
 *
 * 内容直接来自仓库根 `docs/user-guide.md`（`?raw` 构建期内联），**不在包内另存副本**：
 * 仓库文档与面板内帮助是同一份，改一处即两处同步，不会出现「文档更新了、面板里还是旧版」。
 *
 * 为什么是站内页而不是外链仓库文档：发布产物（Release tarball）只打包 `mc_commander_server/`
 * 与内联的 `mc-schemas/`，`docs/` 与 `screenshots/` **都不在其中**；面板又面向内网/离线的
 * 自托管部署——外链在「没有外网」的部署里等于没有帮助。故帮助必须随产物走。
 *
 * 截图不渲染：`docs/` 的图片引用是 `../screenshots/*.png`，那些文件同样不在产物内，
 * 本页只能把它们表现为「有图但此处不显示」的诚实占位，不能伪装成图片。
 */
import type { ReactNode } from 'react'
import { ExternalLink, ImageOff } from 'lucide-react'
import { PageHeader } from '@/components/mcs/page-header'
import { Card } from '@/components/mcs/card'
import { cn } from '@/lib/utils'
import guideRaw from '../../../../docs/user-guide.md?raw'
import { parseGuide, type GuideBlock, type GuideInline, type GuideList } from './guide-markdown'

const guide = parseGuide(guideRaw)

/** 标题档位固定映射（页头 xl / 区块 lg / 子块 sm），不随文档深度发散——
 *  门禁第 23 条要求同屏标题 ≤3 档，直接把 markdown 的 h2/h3/h4 逐级落档会越界。 */
const HEADING_CLASSES: Record<number, string> = {
  2: 'text-mcs-lg font-semibold text-mcs-text-default',
  3: 'text-mcs-sm font-semibold text-mcs-text-default',
}

/** 行内渲染。导出理由同 GuideBlocks：真实文档无外链/无深层标题，夹具才测得到这些分支。 */
export function Inline({ nodes }: { nodes: GuideInline[] }) {
  return (
    <>
      {nodes.map((node, i) => {
        if (node.kind === 'strong') {
          return (
            <strong key={i} className="font-semibold text-mcs-text-default">
              {node.text}
            </strong>
          )
        }
        if (node.kind === 'code') {
          return (
            <code
              key={i}
              className="rounded-mcs-xs bg-mcs-bg-subtle px-1 py-px font-mono text-mcs-xs text-mcs-text-default"
            >
              {node.text}
            </code>
          )
        }
        if (node.kind === 'link') {
          // 站内目录锚点用原生锚（同页跳转，不需路由）；跨站链接一律新窗口 + noreferrer，
          // 与设置页「关于」的外链范式一致
          const external = !node.href.startsWith('#')
          return (
            <a
              key={i}
              href={node.href}
              {...(external ? { target: '_blank', rel: 'noreferrer' } : {})}
              className="inline-flex items-center gap-0.5 font-medium text-mcs-accent-fg underline-offset-2 hover:underline"
            >
              {node.text}
              {external && <ExternalLink className="size-3 shrink-0" aria-hidden />}
            </a>
          )
        }
        if (node.kind === 'image') {
          // 产物内没有 screenshots/，如实说明而不是渲染成坏图
          return (
            <span
              key={i}
              className="inline-flex items-center gap-1 text-mcs-xs text-mcs-text-muted"
            >
              <ImageOff className="size-3 shrink-0" aria-hidden />
              {node.alt}（截图见仓库文档）
            </span>
          )
        }
        return <span key={i}>{node.text}</span>
      })}
    </>
  )
}

function List({ list }: { list: GuideList }) {
  const Tag = list.ordered ? 'ol' : 'ul'
  return (
    <Tag
      className={cn(
        'flex flex-col gap-1.5 pl-4 text-mcs-sm text-mcs-text-muted',
        list.ordered ? 'list-decimal' : 'list-disc',
      )}
    >
      {list.items.map((item, i) => (
        <li key={i} className="pl-0.5">
          <Inline nodes={item.inline} />
          {item.sub && (
            <div className="mt-1.5">
              <List list={item.sub} />
            </div>
          )}
        </li>
      ))}
    </Tag>
  )
}

function Table({ head, rows }: { head: GuideInline[][]; rows: GuideInline[][][] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-mcs-sm">
        <thead>
          <tr className="border-b border-mcs-border-muted text-left">
            {head.map((cell, i) => (
              <th key={i} scope="col" className="px-3 py-2 font-medium text-mcs-text-muted">
                <Inline nodes={cell} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-mcs-border-subtle last:border-b-0 align-top">
              {row.map((cell, j) => (
                <td key={j} className="px-3 py-2 text-mcs-text-default">
                  <Inline nodes={cell} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** 单块渲染。导出理由同 GuideBlocks。 */
export function Block({ block }: { block: GuideBlock }) {
  switch (block.kind) {
    case 'heading': {
      // 文档的 h2 是「章节」，h3 是「小节」；h4 及更深在本文档内未出现，兜底 sm 档
      const Tag = block.depth <= 3 ? `h2` : 'h3'
      return (
        // scroll-mt 让锚点跳转后标题不被容器顶部贴边遮住
        <Tag
          id={block.id}
          className={cn('scroll-mt-4', HEADING_CLASSES[block.depth] ?? HEADING_CLASSES[3])}
        >
          <Inline nodes={block.inline} />
        </Tag>
      )
    }
    case 'paragraph':
      return (
        <p className="text-mcs-sm text-mcs-text-muted">
          <Inline nodes={block.inline} />
        </p>
      )
    case 'list':
      return <List list={block.list} />
    case 'table':
      return <Table head={block.head} rows={block.rows} />
    case 'quote':
      return (
        <blockquote className="border-l-2 border-mcs-border-default pl-3 text-mcs-xs text-mcs-text-muted">
          <Inline nodes={block.inline} />
        </blockquote>
      )
    case 'divider':
      return <hr className="border-mcs-border-subtle" />
    case 'image':
      return (
        <span className="inline-flex items-center gap-1 text-mcs-xs text-mcs-text-muted">
          <ImageOff className="size-3 shrink-0" aria-hidden />
          {block.alt}（截图见仓库文档）
        </span>
      )
    case 'unknown':
      // 真实文档下测试断言为 0；留着是为了「文档加了新构件」时内容**可见地**出现，
      // 而不是被静默丢掉（测试会先红，这是兜底显示）
      return (
        <p className="font-mono text-mcs-xs text-mcs-error-fg">
          [{block.line}] {block.text}
        </p>
      )
  }
}

/**
 * 块列表渲染。导出是为了让渲染分支（外链、引用、分隔线等）能用**夹具**单测——
 * 真实文档里没有外链（`grep` 实测 0 处），只对着真实文档测等于让该分支零覆盖。
 */
export function GuideBlocks({ blocks }: { blocks: GuideBlock[] }) {
  return (
    <>
      {blocks.map((block, i) => (
        <Block key={i} block={block} />
      ))}
    </>
  )
}

export function HelpPage(): ReactNode {
  return (
    <div className="@container flex flex-col gap-4 p-4">
      <PageHeader
        title={guide.title}
        description="面板的完整使用流程：从部署、首次设密到日常管理"
      />
      <Card className="flex max-w-3xl flex-col gap-3 p-4 @xl:p-6">
        <GuideBlocks blocks={guide.blocks} />
      </Card>
    </div>
  )
}
