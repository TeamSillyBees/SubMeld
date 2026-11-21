import { execFile } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
export const binaryName = process.platform === 'win32' ? 'mihomo.exe' : 'mihomo'

export function createVerifier({ binary = resolve('bin', binaryName), directory }) {
  const home = join(directory, 'mihomo')
  let lastSuccess
  let work = Promise.resolve()
  return function verify(yaml, compiled) {
    const task = async () => {
      if (lastSuccess === yaml) return null
      await mkdir(home, { recursive: true, mode: 0o700 })
      const file = join(home, 'validate-' + randomUUID() + '.yaml')
      try {
        await writeFile(file, yaml, { mode: 0o600 })
        await exec(binary, ['-t', '-d', home, '-f', file], { timeout: 50000, windowsHide: true, maxBuffer: 1024 * 1024 })
        lastSuccess = yaml
        return null
      } catch (error) {
        const failed = (code, pane, id, message) => ({ severity: 'error', code, pane, id, message })
        if (error.code === 'ENOENT') return failed('core-missing', 'publish', null, '服务端缺少 Mihomo 校验核心，请运行安装命令或设置 SUBMELD_MIHOMO_BIN 后重试。')
        if (error.killed) return failed('core-timeout', 'publish', null, 'Mihomo 校验超时。请检查服务端网络，尤其是 GeoIP / GeoSite 数据下载。')
        const output = String(error.stdout ?? '') + String(error.stderr ?? '')
        const proxy = output.match(/\bproxy\s+(\d+)\s*:/i)
        if (proxy) {
          const node = compiled.nodes.filter(node => node.kept)[Number(proxy[1])]
          return {
            ...failed('core-node', 'nodes', node?.sourceId, 'Mihomo 不接受' + (node ? '节点「' + node.name + '」的' : '一项') + '连接参数。请检查订阅源中的节点参数，或排除该节点后重试。'),
            relatedId: node?.id,
          }
        }
        if (/geo(?:site|ip)|mmdb/i.test(output)) return failed('core-geo', 'rules', null, 'Mihomo 无法加载地理规则或对应数据。请检查地理规则匹配值和服务端网络。')
        if (/proxy group|proxy-group/i.test(output)) return failed('core-group', 'groups', null, 'Mihomo 不接受代理组参数。请检查组内代理和健康检查参数。')
        if (/dns/i.test(output)) return failed('core-dns', 'settings', null, 'Mihomo 不接受当前 DNS 配置。请检查 DNS 地址及选项。')
        if (/rule/i.test(output)) {
          const number = output.match(/\brules?\[(\d+)\]/i)
          const rule = number && compiled.rules[Number(number[1])]
          return { ...failed('core-rule', 'rules', rule?.serviceId, 'Mihomo 不接受一项路由规则或规则集。请检查本页的规则和已获取内容。'), relatedId: rule?.id }
        }
        return failed('core-invalid', 'publish', null, 'Mihomo 未通过配置校验。请检查节点协议、代理组和网络设置。')
      } finally {
        await rm(file, { force: true }).catch(() => {})
      }
    }
    const result = work.then(task)
    work = result.catch(() => {})
    return result
  }
}
