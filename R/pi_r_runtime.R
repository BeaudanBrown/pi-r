# Runtime helpers shared by constrained R workers.

pi_r_runtime_info <- function() {
  list(
    schema_version = "1",
    capabilities = character()
  )
}

pi_r_assert_runtime <- function() {
  info <- pi_r_runtime_info()
  stopifnot(
    identical(info$schema_version, "1"),
    is.character(info$capabilities)
  )
  invisible(info)
}
