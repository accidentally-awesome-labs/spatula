## Phase 16 deferred items (16-4 execution context)

### TS strict-mode error in plan 16-3's apps/api/src/routes/openapi.ts:34

```
src/routes/openapi.ts(34,5): error TS2345: Argument of type '(c: Context<AppEnv, "/openapi.json", {}>) => JSONRespondReturn<any, 200>' is not assignable...
  Types of property '_data' are incompatible.
    Type 'any' is not assignable to type 'never'.
```

Caused by 16-3's response schema using `z.record(z.unknown())` which Hono types as `never`-data. Out of scope for 16-4 (introduced by 16-3); deferred to 16-3's owner.

