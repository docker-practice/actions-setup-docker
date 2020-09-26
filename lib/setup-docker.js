const exec = require('@actions/exec');
const core = require('@actions/core');
const os = require('os');

const DOCKER_VERSION = core.getInput('docker_version');
const DOCKER_CHANNEL = core.getInput('docker_channel');
const DOCKER_CLI_EXPERIMENTAL = core.getInput('docker_cli_experimental');
const DOCKER_DAEMON_JSON = core.getInput('docker_daemon_json');
const DOCKER_BUILDX = core.getInput('docker_buildx');
const DOCKER_NIGHTLY_VERSION = core.getInput('docker_nightly_version');

const systemExec = require('child_process').exec;

let message;

async function shell(cmd) {
  return await new Promise((resolve, reject) => {
    systemExec(cmd, function (error, stdout, stderr) {
      if (error) {
        reject(error);
      }

      if (stderr) {
        reject(stderr);
      }

      resolve(stdout.trim());
    });
  });
}

async function buildx() {
  core.debug('set DOCKER_CLI_EXPERIMENTAL');
  if (DOCKER_CLI_EXPERIMENTAL === 'enabled') {
    core.exportVariable('DOCKER_CLI_EXPERIMENTAL', 'enabled');
  }

  await exec.exec('docker', [
    'buildx',
    'version',
  ]).then(async () => {
    if (DOCKER_BUILDX !== 'true') {
      core.debug('buildx disabled');

      return;
    }

    core.exportVariable('DOCKER_CLI_EXPERIMENTAL', 'enabled');

    // install buildx
    await exec.exec('docker', [
      'run',
      '--rm',
      '--privileged',
      'tonistiigi/binfmt:latest',
      "--install",
      "all"
    ]);

    await exec.exec('ls -la', [
      '/proc/sys/fs/binfmt_misc',
    ]);

    await exec.exec('docker', [
      'buildx',
      'create',
      '--use',
      '--name',
      'mybuilder',
      '--driver',
      'docker-container',
      '--driver-opt',
      'image=moby/buildkit:master'
    ]);

    await exec.exec('docker', [
      'buildx',
      'inspect',
      '--bootstrap'
    ]);
  }, () => {
    core.debug('NOT Support Buildx');
  });
}

async function run() {
  const platform = os.platform();

  if (platform === 'windows') {
    core.debug('check platform');
    await exec.exec('echo',
      [`Only Support Linux and macOS platform, this platform is ${os.platform()}`]);

    return
  }

  if (platform !== 'linux') {
    // macos
    await exec.exec('docker', [
      '--version']).catch(() => { });

    await exec.exec('docker-compose', [
      '--version']).catch(() => { });

    await core.group('install docker', exec.exec('brew', [
      'cask',
      'install',
      'docker'
    ]));

    await exec.exec('mkdir', [
      '-p',
      '/home/runner/.docker'
    ]);

    await shell(`echo '${DOCKER_DAEMON_JSON}' | sudo tee /home/runner/.docker/daemon.json`);

    await core.group('show daemon json content', exec.exec('cat', [
      '/home/runner/.docker/daemon.json',
    ]));

    // allow the app to run without confirmation
    await exec.exec('xattr', [
      '-d',
      '-r',
      'com.apple.quarantine',
      '/Applications/Docker.app'
    ]);

    // preemptively do docker.app's setup to avoid any gui prompts
    await core.group('start docker', exec.exec('sudo', [
      'bash',
      '-c',
      `
set -x

sudo /bin/cp /Applications/Docker.app/Contents/Library/LaunchServices/com.docker.vmnetd /Library/PrivilegedHelperTools
sudo /bin/cp /Applications/Docker.app/Contents/Resources/com.docker.vmnetd.plist /Library/LaunchDaemons/
sudo /bin/chmod 544 /Library/PrivilegedHelperTools/com.docker.vmnetd
sudo /bin/chmod 644 /Library/LaunchDaemons/com.docker.vmnetd.plist
sudo /bin/launchctl load /Library/LaunchDaemons/com.docker.vmnetd.plist
open -g /Applications/Docker.app || exit

sleep 60

docker info > /dev/null || true

sleep 30

docker info > /dev/null || true
# Wait for the server to start up, if applicable.
i=0
while ! docker system info &>/dev/null; do
(( i++ == 0 )) && printf %s '-- Waiting for Docker to finish starting up...' || printf '.'
sleep 1
done
(( i )) && printf '\n'

echo "-- Docker is ready."
`]));

    await core.group('docker version', exec.exec('docker', ['version']));

    await core.group('docker info', exec.exec('docker', ['info']));

    await core.group('set up buildx', buildx());

    return
  }

  message = 'check docker systemd status';
  await core.group(message, exec.exec('sudo', [
    'systemctl',
    'status',
    'docker',
  ])).then(() => { }).catch(() => { });

  message = 'check docker version'
  core.debug(message);
  await core.group(message, exec.exec('docker', [
    'version',
  ])).catch(() => { });

  if (DOCKER_CHANNEL === 'nightly') {
    await core.group('download deb', exec.exec('curl', [
      '-fsSL',
      '-o',
      '/tmp/moby-snapshot-ubuntu-focal-x86_64-deb.tbz',
      `https://github.com/AkihiroSuda/moby-snapshot/releases/download/${DOCKER_NIGHTLY_VERSION}/moby-snapshot-ubuntu-focal-x86_64-deb.tbz`
    ]));

    await exec.exec('sudo', [
      'rm',
      '-rf',
      '/tmp/*.deb'
    ]);

    await core.group('unpack tbz file', exec.exec('tar', [
      'xjvf',
      '/tmp/moby-snapshot-ubuntu-focal-x86_64-deb.tbz',
      '-C',
      '/tmp'
    ]));

    await core.group('update apt cache', exec.exec('sudo', [
      'apt-get',
      'update',
    ])).catch(() => { });

    await core.group('remove default moby', exec.exec('sudo', [
      'sh',
      '-c',
      "apt remove -y moby-buildx moby-cli moby-containerd moby-engine moby-runc"
    ])).catch(() => { });

    await core.group('install docker', exec.exec('sudo', [
      'sh',
      '-c',
      'apt-get install -y /tmp/*.deb'
    ]).catch(async () => {
      await core.group('download libseccomp2_2.4.3 deb for old os', exec.exec('curl', [
        '-fsSL',
        '-o',
        '/tmp/libseccomp2_2.4.3-1+b1_amd64.deb',
        'http://ftp.us.debian.org/debian/pool/main/libs/libseccomp/libseccomp2_2.4.3-1+b1_amd64.deb'
      ]));

      await core.group('install docker', exec.exec('sudo', [
        'sh',
        '-c',
        'dpkg -i /tmp/*.deb'
      ]));
    }));

  } else {
    core.debug('add apt-key');
    await exec.exec('curl', [
      '-fsSL',
      '-o',
      '/tmp/docker.gpg',
      'https://download.docker.com/linux/ubuntu/gpg',
    ]);
    await exec.exec('sudo', [
      'apt-key',
      'add',
      '/tmp/docker.gpg',
    ]);

    message = 'add apt source';
    core.debug(message);
    const UBUNTU_CODENAME = await shell('lsb_release -cs');
    await core.group(message, exec.exec('sudo', [
      'add-apt-repository',
      `deb [arch=amd64] https://download.docker.com/linux/ubuntu ${UBUNTU_CODENAME} ${DOCKER_CHANNEL}`,
    ]));

    message = 'update apt cache'
    core.debug(message);
    await core.group(message, exec.exec('sudo', [
      'apt-get',
      'update',
    ])).catch(() => { });

    message = 'show available docker version';
    core.debug(message);
    await core.group(mesage, exec.exec('apt-cache', [
      'madison',
      'docker-ce',
      '|',
      'grep',
      '19.03'
    ]));

    const DOCKER_VERSION_STRING = await shell(
      `apt-cache madison docker-ce | grep ${DOCKER_VERSION} | head -n 1 | awk '{print $3}' | sed s/[[:space:]]//g`)

    if (!DOCKER_VERSION_STRING) {
      const OS = await shell(
        `cat /etc/os-release | grep VERSION_ID | cut -d '=' -f 2`
      );

      core.warning(`Docker ${DOCKER_VERSION} not available on ubuntu ${OS}, install latest docker version`);
    }

    message = 'install docker'
    core.debug(message);
    await core.group(message, exec.exec('sudo', [
      'apt-get',
      '-y',
      'install',
      DOCKER_VERSION_STRING ? `docker-ce=${DOCKER_VERSION_STRING}` : 'docker-ce',
      DOCKER_VERSION_STRING ? `docker-ce-cli=${DOCKER_VERSION_STRING}` : 'docker-ce-cli'
    ]));
  }

  message = 'check docker version';
  core.debug(message);
  await core.group(message, await exec.exec('docker', [
    'version',
  ]));

  message = 'check docker systemd status';
  core.debug(message);
  await core.group(message, exec.exec('sudo', [
    'systemctl',
    'status',
    'docker',
  ]));

  // /etc/docker/daemon.json
  core.debug('set /etc/docker/daemon.json');
  await core.group('show default daemon json content', exec.exec('sudo', [
    'cat',
    '/etc/docker/daemon.json',
  ]));

  await shell(`echo '${DOCKER_DAEMON_JSON}' | sudo tee /etc/docker/daemon.json`);

  await core.group('show daemon json content', exec.exec('sudo', [
    'cat',
    '/etc/docker/daemon.json',
  ]));

  await exec.exec('sudo', [
    'systemctl',
    'restart',
    'docker',
  ]);

  await core.group('set up buildx', buildx());
}

run().then(() => {
  console.log('Run success');
}).catch((e) => {
  core.setFailed(e.toString());
});
