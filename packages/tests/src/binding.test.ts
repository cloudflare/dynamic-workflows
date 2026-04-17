import {
  type DispatcherEnvelope,
  unwrapParams,
  type WorkflowBindingLike,
  type WorkflowInstanceCreateOptionsLike,
  type WorkflowInstanceLike,
  wrapParams,
  wrapWorkflowBinding,
} from 'dynamic-workflows';
import { describe, expect, it, vi } from 'vitest';

function makeFakeInstance(id: string): WorkflowInstanceLike {
  return {
    id,
    status: async () => ({ status: 'queued' }),
    pause: async () => {},
    resume: async () => {},
    terminate: async () => {},
    restart: async () => {},
  };
}

function makeFakeBinding(): {
  binding: WorkflowBindingLike;
  create: ReturnType<typeof vi.fn>;
  createBatch: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
} {
  const create = vi.fn(async (opts?: WorkflowInstanceCreateOptionsLike) =>
    makeFakeInstance(opts?.id ?? 'auto-id')
  );
  const createBatch = vi.fn(async (batch: WorkflowInstanceCreateOptionsLike[]) =>
    batch.map((opts) => makeFakeInstance(opts.id ?? 'auto-id'))
  );
  const get = vi.fn(async (id: string) => makeFakeInstance(id));

  const binding: WorkflowBindingLike = { create, createBatch, get };
  return { binding, create, createBatch, get };
}

describe('wrapParams / unwrapParams', () => {
  it('wraps params in a dispatcher envelope', () => {
    const envelope = wrapParams({ foo: 'bar' }, { tenantId: 't1' });
    expect(envelope).toEqual({
      __dispatcherMetadata: { tenantId: 't1' },
      params: { foo: 'bar' },
    });
  });

  it('round-trips through unwrapParams', () => {
    const envelope = wrapParams({ hello: 'world' }, { tenantId: 'acme' });
    const unwrapped = unwrapParams<{ hello: string }>(envelope);
    expect(unwrapped).toEqual({
      metadata: { tenantId: 'acme' },
      params: { hello: 'world' },
    });
  });

  it('returns null when payload is not an envelope', () => {
    expect(unwrapParams(null)).toBeNull();
    expect(unwrapParams(undefined)).toBeNull();
    expect(unwrapParams({ hello: 'world' })).toBeNull();
    expect(unwrapParams('some string')).toBeNull();
    expect(unwrapParams(42)).toBeNull();
  });

  it('handles wrapping undefined params', () => {
    const envelope = wrapParams(undefined, { tenantId: 't1' });
    expect(envelope.params).toBeUndefined();
    expect(envelope.__dispatcherMetadata).toEqual({ tenantId: 't1' });

    const unwrapped = unwrapParams(envelope);
    expect(unwrapped?.params).toBeUndefined();
    expect(unwrapped?.metadata).toEqual({ tenantId: 't1' });
  });
});

describe('wrapWorkflowBinding', () => {
  it('injects metadata into create() params', async () => {
    const { binding, create } = makeFakeBinding();
    const wrapped = wrapWorkflowBinding(binding, { tenantId: 'tenant-42' });

    await wrapped.create({ id: 'wf-1', params: { input: 'hello' } });

    expect(create).toHaveBeenCalledTimes(1);
    const calledWith = create.mock.calls[0]?.[0] as WorkflowInstanceCreateOptionsLike;
    expect(calledWith.id).toBe('wf-1');
    const envelope = calledWith.params as DispatcherEnvelope;
    expect(envelope.__dispatcherMetadata).toEqual({ tenantId: 'tenant-42' });
    expect(envelope.params).toEqual({ input: 'hello' });
  });

  it('injects metadata when create() is called with no options', async () => {
    const { binding, create } = makeFakeBinding();
    const wrapped = wrapWorkflowBinding(binding, { tenantId: 't1' });

    await wrapped.create();

    const calledWith = create.mock.calls[0]?.[0] as WorkflowInstanceCreateOptionsLike;
    const envelope = calledWith.params as DispatcherEnvelope;
    expect(envelope.__dispatcherMetadata).toEqual({ tenantId: 't1' });
    expect(envelope.params).toBeUndefined();
  });

  it('injects metadata when create() has no params', async () => {
    const { binding, create } = makeFakeBinding();
    const wrapped = wrapWorkflowBinding(binding, { tenantId: 't1' });

    await wrapped.create({ id: 'wf-no-params' });

    const calledWith = create.mock.calls[0]?.[0] as WorkflowInstanceCreateOptionsLike;
    expect(calledWith.id).toBe('wf-no-params');
    const envelope = calledWith.params as DispatcherEnvelope;
    expect(envelope.__dispatcherMetadata).toEqual({ tenantId: 't1' });
    expect(envelope.params).toBeUndefined();
  });

  it('passes arbitrary metadata shapes', async () => {
    const { binding, create } = makeFakeBinding();
    const wrapped = wrapWorkflowBinding(binding, {
      tenantId: 'acme',
      region: 'us-east',
      features: ['beta', 'pro'],
      nested: { version: 3 },
    });

    await wrapped.create({ params: { job: 'x' } });

    const calledWith = create.mock.calls[0]?.[0] as WorkflowInstanceCreateOptionsLike;
    const envelope = calledWith.params as DispatcherEnvelope;
    expect(envelope.__dispatcherMetadata).toEqual({
      tenantId: 'acme',
      region: 'us-east',
      features: ['beta', 'pro'],
      nested: { version: 3 },
    });
  });

  it('injects metadata into every item of createBatch()', async () => {
    const { binding, createBatch } = makeFakeBinding();
    const wrapped = wrapWorkflowBinding(binding, { tenantId: 't1' });

    const instances = await wrapped.createBatch([
      { id: 'a', params: { n: 1 } },
      { id: 'b', params: { n: 2 } },
      { id: 'c' },
    ]);

    expect(instances.map((i) => i.id)).toEqual(['a', 'b', 'c']);

    const calledWith = createBatch.mock.calls[0]?.[0] as WorkflowInstanceCreateOptionsLike[];
    expect(calledWith).toHaveLength(3);
    for (const opts of calledWith) {
      const envelope = opts.params as DispatcherEnvelope;
      expect(envelope.__dispatcherMetadata).toEqual({ tenantId: 't1' });
    }
    expect((calledWith[0]?.params as DispatcherEnvelope).params).toEqual({ n: 1 });
    expect((calledWith[1]?.params as DispatcherEnvelope).params).toEqual({ n: 2 });
    expect((calledWith[2]?.params as DispatcherEnvelope).params).toBeUndefined();
  });

  it('forwards get() unchanged', async () => {
    const { binding, get } = makeFakeBinding();
    const wrapped = wrapWorkflowBinding(binding, { tenantId: 't1' });

    const instance = await wrapped.get('some-id');

    expect(get).toHaveBeenCalledWith('some-id');
    expect(instance.id).toBe('some-id');
  });

  it('returns instances unchanged from the underlying binding', async () => {
    const { binding, create } = makeFakeBinding();
    create.mockImplementationOnce(async () => ({
      ...makeFakeInstance('abc'),
      id: 'returned-id',
    }));

    const wrapped = wrapWorkflowBinding(binding, { tenantId: 't1' });
    const instance = await wrapped.create({ params: { a: 1 } });

    expect(instance.id).toBe('returned-id');
  });

  it('does not mutate the caller-provided options', async () => {
    const { binding } = makeFakeBinding();
    const wrapped = wrapWorkflowBinding(binding, { tenantId: 't1' });

    const options = { id: 'wf-1', params: { value: 42 } };
    await wrapped.create(options);

    // The caller's object should still have the original params reference.
    expect(options.params).toEqual({ value: 42 });
  });

  it('does not double-wrap if the same wrapped binding is used twice', async () => {
    // Sanity-check: creating two workflows with the same wrapped binding
    // should never produce nested envelopes.
    const { binding, create } = makeFakeBinding();
    const wrapped = wrapWorkflowBinding(binding, { tenantId: 't1' });

    await wrapped.create({ params: { a: 1 } });
    await wrapped.create({ params: { a: 2 } });

    for (const call of create.mock.calls) {
      const envelope = (call[0] as WorkflowInstanceCreateOptionsLike).params as DispatcherEnvelope;
      expect('__dispatcherMetadata' in ((envelope.params as object) ?? {})).toBe(false);
    }
  });
});
