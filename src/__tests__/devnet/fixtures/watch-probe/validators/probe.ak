//// A deliberately trivial validator, used as a fixture for `ada dev`.
////
//// It imports nothing, so it compiles in seconds with no network and no
//// dependency resolution — a fixture that needed to fetch stdlib would make
//// the watch-loop tests slow and flaky for reasons unrelated to what they check.
////
//// The threshold below is what the tests edit. It is compared against the
//// redeemer rather than a constant so the compiler cannot fold the comparison
//// away: the point of the edit is that the compiled code, and therefore the
//// script hash and the address, genuinely change.

validator probe {
  mint(redeemer: Int, _policy_id: ByteArray, _self: Data) {
    redeemer > 10
  }

  else(_) {
    fail
  }
}
