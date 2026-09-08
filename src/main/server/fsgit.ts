import type { ClientRequest } from '@shared/contract'
import * as fs from './fspaths'
import * as git from './gitops'
import * as gh from './github'

type Handled = { handled: true; result: unknown } | { handled: false }
const result = (value: unknown): Handled => ({ handled: true, result: value ?? null })

/** Additive donor methods; existing project-scoped file/Git methods stay independent. */
export async function handleFsGit(req: ClientRequest): Promise<Handled> {
  switch (req.method) {
    case 'fs.listPath': return result(await fs.fsListPath(req.params.path))
    case 'fs.projectFiles': return result(await fs.fsProjectFiles(req.params.cwd))
    case 'fs.createPath': return result(await fs.fsCreatePath(req.params.parent, req.params.name, req.params.isDir))
    case 'fs.renamePath': return result(await fs.fsRenamePath(req.params.path, req.params.name))
    case 'fs.deletePath': return result(await fs.fsDeletePath(req.params.path))
    case 'fs.copyPath': return result(await fs.fsCopyPath(req.params.from, req.params.destParent))
    case 'fs.movePath': return result(await fs.fsMovePath(req.params.from, req.params.destParent))
    case 'fs.readPreview': return result(await fs.fsReadPreview(req.params.path, req.params.maxLines, req.params.startLine))
    case 'fs.statFiles': return result(await fs.fsStatFiles(req.params.paths))
    case 'fs.inspectPaths': return result(await fs.fsInspectPaths(req.params.paths))
    case 'fs.readBase64': return result(await fs.fsReadBase64(req.params.path))
    case 'fs.readText': return result(await fs.fsReadText(req.params.path))
    case 'fs.writeText': return result(await fs.fsWriteText(req.params.path, req.params.content))
    case 'git.diffStats': return result(await git.gitDiffStats(req.params.cwd))
    case 'git.diffIndex': return result(await git.gitDiffIndex(req.params.cwd))
    case 'git.fileDiff': return result(await git.gitFileDiff(req.params.cwd, req.params.relative, req.params.base))
    case 'git.stagedContext': return result(await git.gitStagedContext(req.params.cwd))
    case 'git.rangeContext': return result(await git.gitRangeContext(req.params.cwd))
    case 'git.branches': return result(await git.gitBranches(req.params.cwd))
    case 'git.clone': return result(await git.gitClone(req.params.url, req.params.parent))
    case 'git.stageFile': return result(await git.gitStageFile(req.params.cwd, req.params.relative))
    case 'git.stageContents': return result(await git.gitStageContents(req.params.cwd, req.params.relative, req.params.contents))
    case 'git.unstageFile': return result(await git.gitUnstageFile(req.params.cwd, req.params.relative))
    case 'git.discardFile': return result(await git.gitDiscardFile(req.params.cwd, req.params.relative))
    case 'git.stageAll': return result(await git.gitStageAll(req.params.cwd))
    case 'git.unstageAll': return result(await git.gitUnstageAll(req.params.cwd))
    case 'git.commitStaged': return result(await git.gitCommitStaged(req.params.cwd, req.params.message))
    case 'git.push': return result(await git.gitPush(req.params.cwd))
    case 'git.pull': return result(await git.gitPull(req.params.cwd))
    case 'git.sync': return result(await git.gitSync(req.params.cwd))
    case 'git.checkout': return result(await git.gitCheckout(req.params.cwd, req.params.name, req.params.remote))
    case 'git.createBranch': return result(await git.gitCreateBranch(req.params.cwd, req.params.name))
    case 'git.stash': return result(await git.gitStash(req.params.cwd, req.params.message))
    case 'git.log': return result(await git.gitLog(req.params.cwd, req.params.limit))
    case 'github.repo': return result(await gh.githubRepo(req.params.cwd))
    case 'github.workItems': return result(await gh.githubWorkItems(req.params.cwd, req.params.kind, req.params.assignedToMe, req.params.state, req.params.search, req.params.limit))
    case 'github.details': return result(await gh.githubDetails(req.params.cwd, req.params.kind, req.params.number))
    case 'github.thread': return result(await gh.githubThread(req.params.cwd, req.params.kind, req.params.number))
    case 'github.comment': return result(await gh.githubComment(req.params.cwd, req.params.kind, req.params.number, req.params.body, req.params.inReplyTo))
    case 'github.prDiff': return result(await gh.githubPrDiff(req.params.cwd, req.params.number))
    case 'github.prStatus': return result(await gh.githubPrStatus(req.params.cwd))
    case 'github.createPr': return result(await gh.githubCreatePr(req.params.cwd, req.params.title, req.params.body, req.params.base, req.params.head))
    default: return { handled: false }
  }
}
