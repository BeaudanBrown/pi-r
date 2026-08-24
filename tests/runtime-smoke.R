helper <- Sys.getenv("PI_R_HELPER", unset = NA_character_)
stopifnot(!is.na(helper), file.exists(helper))

source(helper, local = TRUE)
info <- pi_r_assert_runtime()

stopifnot(
  identical(info$schema_version, "1"),
  identical(info$capabilities, character())
)
