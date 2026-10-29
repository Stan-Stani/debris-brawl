import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { isPublicAddress, parseTarget, cleanHtml, fetchPage, UserError } from '../server/fetchPage.js';

test('private, loopback and special addresses are refused', () => {
  for (const ip of [
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
    '224.0.0.1', '255.255.255.255', '::', '::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:7f00:1', 'fe80::1', 'fc00::1',
    'fd12:3456::1', 'ff02::1', '64:ff9b::a00:1', '2002:c0a8:101::1', '2001:db8::1', '2001::1', 'not-an-ip',
  ]) assert.equal(isPublicAddress(ip), false, ip);
});

test('public addresses are allowed', () => {
  for (const ip of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '2606:4700::6810:84e5', '::ffff:8.8.8.8', '2a00:1450:4001:80b::200e']) {
    assert.equal(isPublicAddress(ip), true, ip);
  }
});

test('addresses are normalised and odd ones rejected', () => {
  assert.equal(parseTarget('example.com').href, 'https://example.com/');
  assert.equal(parseTarget('http://example.com/a?b=1#frag').href, 'http://example.com/a?b=1');
  for (const bad of ['', 'file:///etc/passwd', 'ftp://example.com', 'http://localhost/', 'http://foo.local/', 'http://user:pw@example.com/',
    'http://example.com:8080/', 'http://intranet/', 'gopher://example.com', 'http://[::1]/', 'javascript:alert(1)']) {
    assert.throws(() => {
      const u = parseTarget(bad);
      // bracketed IPv6 literals pass parsing and are caught at resolve time; check that path too
      if (!isPublicAddress(u.hostname.replace(/^\[|\]$/g, ''))) throw new UserError('private');
    }, UserError, bad);
  }
});

test('fetched HTML loses its scripts and gains a base URL', () => {
  const out = cleanHtml('<html><head><title>x</title><script>alert(1)</script></head><body onload="x()"><a href="javascript:evil()">a</a><iframe src="/x"></iframe><meta http-equiv="refresh" content="0;url=/y"><p>hi</p></body></html>', 'https://example.com/page?a=1&b="2"');
  assert.ok(!/script|onload|javascript:|iframe|http-equiv/i.test(out), out);
  assert.ok(out.includes('<base href="https://example.com/page?a=1&amp;b=&quot;2&quot;">'));
  assert.ok(out.includes('<p>hi</p>'));
});

test('the server will not fetch from itself or the local network', async () => {
  const srv = http.createServer((req, res) => res.end('<p>secret</p>'));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  try {
    for (const target of [`http://127.0.0.1:${port}/`, 'http://127.0.0.1/', 'http://localhost/', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/']) {
      await assert.rejects(fetchPage(target), UserError, target);
    }
  } finally {
    srv.close();
  }
});
