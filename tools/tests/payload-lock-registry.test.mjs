/**
 * 发布载荷 lock 的 registry 判据单测。
 *
 * 为什么要有：载荷打包是发布链路入口，判据判宽会让内网镜像地址漏到用户机上
 * （`npm ci` 在用户机 ENOTFOUND，安装脚本中断，用户拿到装不上的包）；判窄会让
 * 打包当场中止——本地链接条目被判成外域就是真实发生过的形态。
 */
import { describe, it, expect } from 'vitest'
import { findForeignResolved } from '../deploy/stage-payload.mjs'

/** 造一段最小 lock 文本，条目形态与 npm 实际产物一致（多行、可含 link） */
function lockWith(...entries) {
  const pkgs = entries.map((e, i) => {
    const lines = [`    "node_modules/pkg-${i}": {`]
    if (e.resolved) lines.push(`      "resolved": "${e.resolved}",`)
    if (e.version) lines.push(`      "version": "${e.version}",`)
    if (e.link) lines.push('      "link": true,')
    lines.push('    }')
    return lines.join('\n').replace(/,\n    }$/, '\n    }')
  })
  return `{\n  "packages": {\n${pkgs.join(',\n')}\n  }\n}\n`
}

describe('findForeignResolved', () => {
  it('公共 registry 一律放行', () => {
    expect(
      findForeignResolved(
        lockWith(
          { resolved: 'https://registry.npmjs.org/express/-/express-4.19.2.tgz' },
          { resolved: 'https://registry.npmjs.org/zod/-/zod-3.23.8.tgz' },
        ),
      ),
    ).toEqual([])
  })

  it('内网镜像域被拦下（用户机上解析不到）', () => {
    const bad = findForeignResolved(
      lockWith({ resolved: 'https://mirrors.tencentyun.com/npm/express/-/express-4.19.2.tgz' }),
    )
    expect(bad).toHaveLength(1)
    expect(bad[0]).toContain('mirrors.tencentyun.com')
  })

  it('本地链接条目放行——resolved 是裸目录名、指向产物内的 vendor 包', () => {
    // 真实形态：{"resolved": "mc-schemas", "link": true}。
    // 它不经 registry，解析不出 host，按 host 比对会判成外域并让打包中止。
    expect(findForeignResolved(lockWith({ resolved: 'mc-schemas', link: true }))).toEqual([])
  })

  it('本地链接与镜像域混排时只拦镜像域', () => {
    const bad = findForeignResolved(
      lockWith(
        { resolved: 'mc-schemas', link: true },
        { resolved: 'https://mirrors.tencentyun.com/npm/zod/-/zod-3.23.8.tgz' },
        { resolved: 'https://registry.npmjs.org/express/-/express-4.19.2.tgz' },
      ),
    )
    expect(bad).toHaveLength(1)
    expect(bad[0]).toContain('tencentyun')
  })

  it('条目内有嵌套对象时仍然拦得下（嵌套会让按花括号圈范围的正则整体匹配失败）', () => {
    const lock = JSON.stringify({
      packages: {
        'node_modules/evil': {
          resolved: 'https://evil.example.com/x.tgz',
          engines: { node: '>=18' },
          dependencies: { ms: '2.1.3' },
        },
      },
    })
    expect(findForeignResolved(lock)).toHaveLength(1)
  })

  it('不带 link 的裸路径被拦下（判不了来源就不放行）', () => {
    expect(findForeignResolved(lockWith({ resolved: 'mc-schemas' }))).toHaveLength(1)
    expect(findForeignResolved(lockWith({ resolved: 'not-a-url' }))).toHaveLength(1)
  })
})
