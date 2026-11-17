'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { resolveRuntimeDirectory } = require('./prepare-workflow-09-runtime.cjs');

const PROJECT_PATTERN = /^mailflow-w09-[a-f0-9]{12}$/;
const CONTAINER_SERVICES = new Set(['n8n', 'n8n-postgres', 'mailflow-postgres', 'w09-gmail-mock']);
const NETWORKS = new Set(['runtime', 'persistence']);

function resolveProject(runtimeDir, projectName) {
  const resolvedRuntimeDir = resolveRuntimeDirectory(runtimeDir);
  if (typeof projectName !== 'string' || !PROJECT_PATTERN.test(projectName)) {
    throw new Error('Invalid workflow 09 Compose project name');
  }

  const marker = JSON.parse(
    fs.readFileSync(path.join(resolvedRuntimeDir, '.mailflow-w09-runtime'), 'utf8'),
  );
  if (projectName !== marker.projectName) {
    throw new Error('Compose project does not match the generated runtime marker');
  }

  const root = path.resolve(__dirname, '..');
  const composeFile = path.join(root, 'tests/runtime/workflow-09/compose.yaml');
  return {
    projectName,
    composeFile,
    environmentFile: path.join(resolvedRuntimeDir, 'compose.env'),
    runtimeDir: resolvedRuntimeDir,
    workingDir: path.dirname(composeFile),
  };
}

function dockerOutput(args, run = execFileSync) {
  return run('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function listIds(kind, projectName, run) {
  const args =
    kind === 'container'
      ? ['ps', '-aq', '--filter', `label=com.docker.compose.project=${projectName}`]
      : ['network', 'ls', '-q', '--filter', `label=com.docker.compose.project=${projectName}`];
  return dockerOutput(args, run).split(/\s+/).filter(Boolean);
}

function assertProjectUnused(identity, run = execFileSync) {
  const containers = listIds('container', identity.projectName, run);
  const networks = listIds('network', identity.projectName, run);
  if (containers.length || networks.length) {
    throw new Error('Compose project already has Docker resources; refusing to reuse them');
  }
}

function inspectLabels(id, resourceType, run) {
  const format = resourceType === 'container' ? '{{json .Config.Labels}}' : '{{json .Labels}}';
  return JSON.parse(dockerOutput(['inspect', '--format', format, id], run));
}

function assertProjectOwned(identity, run = execFileSync) {
  const containers = listIds('container', identity.projectName, run);
  const networks = listIds('network', identity.projectName, run);

  for (const id of containers) {
    const labels = inspectLabels(id, 'container', run) ?? {};
    if (
      labels['com.docker.compose.project'] !== identity.projectName ||
      labels['com.docker.compose.project.config_files'] !== identity.composeFile ||
      labels['com.docker.compose.project.environment_file'] !== identity.environmentFile ||
      labels['com.docker.compose.project.working_dir'] !== identity.workingDir ||
      !CONTAINER_SERVICES.has(labels['com.docker.compose.service'])
    ) {
      throw new Error('Compose project contains a container not owned by this workflow 09 harness');
    }
  }

  for (const id of networks) {
    const labels = inspectLabels(id, 'network', run) ?? {};
    const name = dockerOutput(['inspect', '--format', '{{.Name}}', id], run);
    if (
      labels['com.docker.compose.project'] !== identity.projectName ||
      !NETWORKS.has(labels['com.docker.compose.network']) ||
      name !== `${identity.projectName}_${labels['com.docker.compose.network']}`
    ) {
      throw new Error('Compose project contains a network not owned by this workflow 09 harness');
    }
  }
}

function main() {
  if (process.argv.length !== 5) {
    throw new Error(
      'Usage: node scripts/verify-workflow-09-compose-project.cjs <runtime-dir> <project-name> <assert-new|assert-owned>',
    );
  }
  const [, , runtimeDir, projectName, mode] = process.argv;
  const identity = resolveProject(runtimeDir, projectName);
  if (mode === 'assert-new') assertProjectUnused(identity);
  else if (mode === 'assert-owned') assertProjectOwned(identity);
  else throw new Error('Project guard mode must be assert-new or assert-owned');
  console.log(`Workflow 09 Compose project is safe for ${mode}: ${identity.projectName}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`Workflow 09 Compose project guard refused: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  assertProjectOwned,
  assertProjectUnused,
  resolveProject,
};
