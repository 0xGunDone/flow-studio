const {test}=require('node:test');
const assert=require('node:assert/strict');
const {assertNoSecretLiteral}=require('./secret-patterns.cjs');

test('release rejects key-shaped literals without echoing values',()=>{
  for(const value of ['AI'+'za'+'x'.repeat(35),'AI'+'za'+'x'.repeat(34)+'-','gh'+'p_'+'x'.repeat(36),'-----BEGIN '+'PRIVATE KEY-----']){
    assert.throws(()=>assertNoSecretLiteral('source.py',value),error=>{
      assert(error.message.includes('source.py'));assert(!error.message.includes(value));return true;
    });
  }
  assert.doesNotThrow(()=>assertNoSecretLiteral('source.py','api_key = os.environ.get("FLOW_API_KEY")'));
});
