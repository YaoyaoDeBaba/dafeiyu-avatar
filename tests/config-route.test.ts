/**
 * config-route.test —— `GET /avatar/config` 的三种情形。
 *
 * 这条路由是"行为表外置"的入口：文件写坏了**不许**变成"形象不动了"，
 * 必须回落成 `{}` 让客户端走默认值。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { avatarConfigHandler } from '../src/host/routes.js'

interface FakeResponse {
  status: number
  headers: Record<string, string>
  body: string
  setHeader(name: string, value: string): void
  writeHead(status: number, headers?: Record<string, string>): void
  end(payload?: string): void
}

function call(dir: string, method = 'GET'): FakeResponse {
  const response: FakeResponse = {
    status: 0,
    headers: {},
    body: '',
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value
    },
    writeHead(status, headers) {
      this.status = status
      for (const [key, value] of Object.entries(headers ?? {})) this.headers[key.toLowerCase()] = value
    },
    end(payload) {
      if (typeof payload === 'string') this.body = payload
    },
  }
  const request = { method, headers: { host: '127.0.0.1:58943' }, url: '/api/dsh-remote-dafeiyu/avatar/config' }
  avatarConfigHandler(dir)(request as never, response as never)
  return response
}

test('配置文件存在：原样返回 config', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'avatar-cfg-'))
  try {
    writeFileSync(path.join(dir, 'avatar-config.json'), JSON.stringify({ workChance: 0.9, moveSpeed: 60 }))
    const response = call(dir)
    assert.equal(response.status, 200)
    const body = JSON.parse(response.body) as { ok: boolean; config: { workChance: number; moveSpeed: number } }
    assert.equal(body.ok, true)
    assert.equal(body.config.workChance, 0.9)
    assert.equal(body.config.moveSpeed, 60)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('没有配置文件：返回空对象（客户端走默认值）', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'avatar-cfg-'))
  try {
    const body = JSON.parse(call(dir).body) as { ok: boolean; config: unknown }
    assert.equal(body.ok, true)
    assert.deepEqual(body.config, {})
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('JSON 写坏了：也返回空对象，不 500', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'avatar-cfg-'))
  try {
    writeFileSync(path.join(dir, 'avatar-config.json'), '{ "workChance": 0.9,,, }')
    const response = call(dir)
    assert.equal(response.status, 200)
    assert.deepEqual((JSON.parse(response.body) as { config: unknown }).config, {})
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('非 GET：405', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'avatar-cfg-'))
  try {
    assert.equal(call(dir, 'POST').status, 405)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('非环回 Host：403', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'avatar-cfg-'))
  try {
    const response: FakeResponse = {
      status: 0,
      headers: {},
      body: '',
      setHeader() {},
      writeHead(status) {
        this.status = status
      },
      end() {},
    }
    const request = { method: 'GET', headers: { host: 'example.com' }, url: '/api/dsh-remote-dafeiyu/avatar/config' }
    avatarConfigHandler(dir)(request as never, response as never)
    assert.equal(response.status, 403)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
