import { describe, expect, it } from 'vitest';
import { assertImportableGitUrl, blockedAddress, gitAllowProtocol, gitTransportConfig } from '../src/index.js';

const resolveTo = (addresses: string[]) => async () => addresses;

describe('which Git URLs a project may be imported from', () => {
  it('refuses local files, other schemes, this machine and cloud metadata', async () => {
    await expect(assertImportableGitUrl('file:///C:/data/storage/repos/other-project.git')).rejects.toThrow(/https, http veya ssh/);
    await expect(assertImportableGitUrl('ext::sh -c touch% /tmp/pwned')).rejects.toThrow();
    await expect(assertImportableGitUrl('http://localhost:4000/git/x.git')).rejects.toThrow(/iç servis/);
    await expect(assertImportableGitUrl('http://127.0.0.1:5432/')).rejects.toThrow(/iç servis/);
    await expect(assertImportableGitUrl('http://[::1]/repo.git')).rejects.toThrow(/iç servis/);
    await expect(assertImportableGitUrl('http://169.254.169.254/latest/meta-data')).rejects.toThrow(/iç servis/);
    // A public-looking name that resolves to this machine is refused too.
    await expect(assertImportableGitUrl('https://sneaky.example/repo.git', { resolve: resolveTo(['127.0.0.1']) })).rejects.toThrow(/iç servis/);
  });

  it('accepts public and company (LAN) Git servers over https, http and ssh', async () => {
    await expect(assertImportableGitUrl('https://github.com/org/repo.git', { resolve: resolveTo(['140.82.121.4']) })).resolves.toEqual(['140.82.121.4']);
    await expect(assertImportableGitUrl('http://10.0.5.20/gitlab/team/app.git')).resolves.toEqual([]);
    await expect(assertImportableGitUrl('ssh://git@gitlab.arucad.local/team/app.git', { resolve: resolveTo(['192.168.1.30']) })).resolves.toEqual(['192.168.1.30']);
    // Tests / single-machine installs may opt in to local sources explicitly.
    await expect(assertImportableGitUrl('file:///tmp/fixture.git', { allowLocal: true })).resolves.toEqual([]);
  });

  it('is not fooled by other notations of loopback and metadata addresses', async () => {
    for (const url of ['http://2130706433/r.git', 'http://0x7f.0.0.1/r.git', 'http://0177.0.0.1/r.git', 'http://[::ffff:7f00:1]/r.git', 'http://[::ffff:127.0.0.1]/r.git', 'http://[64:ff9b::a9fe:a9fe]/r.git', 'http://[fe80::1]/r.git']) {
      await expect(assertImportableGitUrl(url), url).rejects.toThrow(/iç servis/);
    }
    // A name that resolves to an IPv6 form of loopback.
    await expect(assertImportableGitUrl('https://evil.example/r.git', { resolve: resolveTo(['93.184.215.14', '::ffff:7f00:1']) })).rejects.toThrow(/iç servis/);
  });

  it('pins the fetch to the address it just checked and refuses redirects (no DNS rebinding)', async () => {
    const config = await gitTransportConfig('https://git.example.com/team/app.git', { resolve: resolveTo(['93.184.215.14']) });
    expect(config).toEqual(['-c', 'http.followRedirects=false', '-c', 'http.curloptResolve=git.example.com:443:93.184.215.14']);
    expect(await gitTransportConfig('http://[2001:db8::5]:8080/app.git')).toEqual(['-c', 'http.followRedirects=false']);
    // The name pointed at a public address when the project was created, at this machine when the worker fetches.
    await expect(gitTransportConfig('https://rebind.example/app.git', { resolve: resolveTo(['127.0.0.1']) })).rejects.toThrow(/iç servis/);
    // SSH connects to the checked address too; the host key is still verified under the real name.
    expect(await gitTransportConfig('ssh://git@gitlab.example.com/app.git', { resolve: resolveTo(['93.184.215.20']) })).toEqual([
      '-c',
      'core.sshCommand=ssh -o HostName=93.184.215.20 -o HostKeyAlias=gitlab.example.com -o CheckHostIP=no -o ProxyCommand=none -o ProxyJump=none -o BatchMode=yes',
    ]);
    expect((await gitTransportConfig('ssh://git@[2001:db8::7]:2222/app.git'))[1]).toContain('HostName=2001:db8::7 ');
    await expect(gitTransportConfig('ssh://git@rebind.example/app.git', { resolve: resolveTo(['169.254.169.254']) })).rejects.toThrow(/iç servis/);
  });

  it('honours an operator allow-list of Git hosts', async () => {
    const policy = { allowedHosts: ['gitlab.arucad.edu.tr', 'github.com'], resolve: resolveTo(['10.1.2.3']) };
    await expect(assertImportableGitUrl('https://gitlab.arucad.edu.tr/a/b.git', policy)).resolves.toEqual(['10.1.2.3']);
    await expect(assertImportableGitUrl('https://api.github.com/a/b.git', policy)).resolves.toBeDefined();
    await expect(assertImportableGitUrl('https://gitlab.example.org/a/b.git', policy)).rejects.toThrow(/izinli listede değil/);
  });

  it('classifies addresses and restricts git transports', () => {
    expect(['127.0.0.5', '0.0.0.0', '169.254.1.1', '::1', '::ffff:127.0.0.1', 'fe80::1'].every(blockedAddress)).toBe(true);
    expect(['10.0.0.1', '192.168.1.1', '172.16.0.1', '8.8.8.8', '2001:db8::1'].some(blockedAddress)).toBe(false);
    expect(gitAllowProtocol()).toBe('https:http:ssh');
    expect(gitAllowProtocol(true)).toContain('file');
  });
});
