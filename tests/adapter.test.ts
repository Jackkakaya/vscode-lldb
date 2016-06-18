'use strict'

import * as assert from 'assert';
import * as path from 'path';
import * as cp from 'child_process';
import * as fs from 'fs';
import {DebugClient} from 'vscode-debugadapter-testsupport';
import {DebugProtocol as dp} from 'vscode-debugprotocol';

const debuggee = 'tests/out/debuggee'
const debuggeeSource = path.normalize(path.join(process.cwd(), 'tests', 'debuggee.cpp'));

var dc: DebugClient;

setup(() => {
    dc = new DebugClient('node', './adapter.js', 'lldb');
    return dc.start(4711);
});

teardown(() => dc.stop());

test('run program to the end', async () => {
    let terminatedAsync = dc.waitForEvent('terminated');
    await launch({ program: debuggee });
    await terminatedAsync;
});

test('run program with modified environment', async () => {
    let waitExitedAsync = dc.waitForEvent('exited');
    await launch({
        env: { 'FOO': 'bar' },
        program: debuggee,
        args: ['check_env', 'FOO', 'bar'],
    });
    let exitedEvent = await waitExitedAsync;
    // debuggee shall return 1 if env[argv[2]] == argv[3]
    assert.equal(exitedEvent.body.exitCode, 1);
});

test('stop on entry', async () => {
    let stopAsync = dc.waitForEvent('stopped');
    launch({ program: debuggee, stopOnEntry: true });
    let stopEvent = await stopAsync;
    if (process.platform.startsWith('win'))
        assert.equal(stopEvent.body.reason, 'exception');
    else
        assert.equal(stopEvent.body.reason, 'signal');
});

test('stop on a breakpoint', async () => {
    let bp_line = findMarker(debuggeeSource, '#BP1');
    let hitBreakpointAsync = hitBreakpoint(debuggeeSource, bp_line);
    await launch({ program: debuggee });
    await hitBreakpointAsync;
    let waitForExitAsync = dc.waitForEvent('exited');
    await dc.continueRequest({ threadId: 0 });
    await waitForExitAsync;
});

test('page stack', async () => {
    let bp_line = findMarker(debuggeeSource, '#BP2');
    let hitBreakpointAsync = hitBreakpoint(debuggeeSource, bp_line);
    await launch({ program: debuggee, args: ['deepstack'] });
    let stoppedEvent = await hitBreakpointAsync;
    let response2 = await dc.stackTraceRequest({ threadId: stoppedEvent.body.threadId, startFrame: 20, levels: 10 });
    assert.equal(response2.body.stackFrames.length, 10)
    let response3 = await dc.scopesRequest({ frameId: response2.body.stackFrames[0].id });
    let response4 = await dc.variablesRequest({ variablesReference: response3.body.scopes[0].variablesReference });
    assert.equal(response4.body.variables[0].name, 'levelsToGo');
    assert.equal(response4.body.variables[0].value, '20');
});

suite('attach tests - these may fail if your system has a locked-down ptrace() syscall', () => {
    var debuggeeProc: cp.ChildProcess;

    suiteSetup(() => {
        debuggeeProc = cp.spawn(debuggee, ['inf_loop'], {});
    })

    suiteTeardown(() => {
        debuggeeProc.kill()
    })

    test('attach by pid', async () => {
        let asyncWaitStopped = dc.waitForEvent('stopped');
        let attachResp = await attach({ program: debuggee, pid: debuggeeProc.pid });
        assert(attachResp.success);
        await asyncWaitStopped;
    });

    test('attach by name - may fail if a copy of debuggee is already running', async () => {
        let asyncWaitStopped = dc.waitForEvent('stopped');
        let attachResp = await attach({ program: debuggee });
        assert(attachResp.success);
        await asyncWaitStopped;
        debuggeeProc.kill()
    });
})

function findMarker(file: string, marker: string): number {
    let data = fs.readFileSync(file, 'utf8');
    let lines = data.split('\n');
    for (var i = 0; i < lines.length; ++i) {
        let pos = lines[i].indexOf(marker);
        if (pos >= 0) return i + 1;
    }
    throw Error('Marker not found');
}

async function launch(launchArgs: any): Promise<dp.LaunchResponse> {
    let waitForInit = dc.waitForEvent('initialized');
    await dc.initializeRequest()
    let attachResp = dc.launchRequest(launchArgs);
    await waitForInit;
    dc.configurationDoneRequest();
    return attachResp;
}

async function attach(attachArgs: any): Promise<dp.AttachResponse> {
    let waitForInit = dc.waitForEvent('initialized');
    await dc.initializeRequest()
    let attachResp = dc.attachRequest(attachArgs);
    await waitForInit;
    dc.configurationDoneRequest();
    return attachResp;
}

async function hitBreakpoint(file: string, line: number): Promise<dp.StoppedEvent> {
    let waitStopAsync = dc.waitForEvent('stopped');
    await dc.waitForEvent('initialized');
    let breakpointResp = await dc.setBreakpointsRequest({
        source: { path: file },
        breakpoints: [{ line: line, column: 0 }],
    });
    let bp = breakpointResp.body.breakpoints[0];
    assert.ok(bp.verified);
    assert.equal(bp.line, line);
    let stopEvent = await waitStopAsync;
    let stackResp = await dc.stackTraceRequest({ threadId: stopEvent.body.threadId });
    let topFrame = stackResp.body.stackFrames[0];
    assert.equal(topFrame.line, line);
    return <dp.StoppedEvent>stopEvent;
}
