suppressPackageStartupMessages(library(jsonlite))

`%||%` <- function(left, right) if (is.null(left)) right else left

bounded_text <- function(value, max_bytes = 2000L) {
  text <- paste(as.character(value %||% character()), collapse = "\n")
  if (nchar(text, type = "bytes") > max_bytes) substr(text, 1L, max_bytes) else text
}

read_metadata <- function() {
  targets::tar_meta(
    fields = c("name", "time", "bytes", "warnings", "error"),
    complete_only = FALSE
  )
}

list_targets <- function(target_names) {
  outdated <- targets::tar_outdated(callr_function = NULL)
  metadata <- read_metadata()
  lapply(target_names, function(name) {
    row <- metadata[metadata$name == name, , drop = FALSE]
    error <- if (nrow(row) && "error" %in% names(row) && !is.na(row$error[[1L]])) bounded_text(row$error[[1L]]) else ""
    freshness <- if (nzchar(error)) {
      "failed"
    } else if (name %in% outdated) {
      "outdated"
    } else if (!nrow(row)) {
      "missing"
    } else {
      "current"
    }
    list(
      name = name,
      freshness = freshness,
      bytes = if (nrow(row) && "bytes" %in% names(row) && !is.na(row$bytes[[1L]])) row$bytes[[1L]] else NULL,
      time = if (nrow(row) && "time" %in% names(row) && !is.na(row$time[[1L]])) as.character(row$time[[1L]]) else NULL,
      warning = if (nrow(row) && "warnings" %in% names(row) && !is.na(row$warnings[[1L]])) bounded_text(row$warnings[[1L]]) else NULL,
      error = if (nzchar(error)) error else NULL
    )
  })
}

run_targets <- function(target_names) {
  condition <- tryCatch({
    targets::tar_make(names = target_names, reporter = "silent", callr_function = NULL)
    NULL
  }, error = identity)
  if (is.null(condition)) {
    return(list(ok = TRUE, status = "succeeded", requested = target_names, targets = list_targets(target_names)))
  }
  progress <- tryCatch(targets::tar_progress(fields = c("name", "progress")), error = function(...) data.frame())
  failed <- if (nrow(progress)) progress$name[progress$progress == "errored"] else character()
  failed_name <- if (length(failed)) tail(failed, 1L) else tail(target_names, 1L)
  traceback <- tryCatch({
    traceback_call <- as.call(list(targets::tar_traceback, as.name(failed_name)))
    capture.output(print(eval(traceback_call), max = 20L))
  }, error = function(trace_error) paste("Traceback unavailable:", conditionMessage(trace_error)))
  list(
    ok = TRUE,
    status = "failed",
    requested = target_names,
    targets = tryCatch(list_targets(target_names), error = function(...) list()),
    error = list(
      code = "TARGET_RUN_FAILED",
      target = failed_name,
      message = bounded_text(conditionMessage(condition)),
      traceback = bounded_text(traceback),
      recoverable = TRUE,
      recovery = c("Inspect the complete local log", "Load the failed workspace with r_target_workspace")
    )
  )
}

request_line <- readLines(file("stdin", open = "r"), n = 1L, warn = FALSE)
request <- fromJSON(request_line, simplifyVector = FALSE)
cat("operation=", request$operation, " requested=", paste(unlist(request$names %||% character()), collapse = ","), "\n", sep = "", file = stderr())

result <- tryCatch({
  target_names <- unlist(request$names %||% character(), use.names = FALSE)
  if (identical(request$operation, "list")) {
    list(ok = TRUE, targets = list_targets(target_names))
  } else if (identical(request$operation, "run")) {
    run_targets(target_names)
  } else {
    stop("Unsupported target runner operation")
  }
}, error = function(condition) {
  list(ok = FALSE, error = list(
    code = "TARGET_RUNNER_FAILED",
    message = bounded_text(conditionMessage(condition)),
    recoverable = TRUE,
    recovery = c("Inspect the complete local log", "Validate the locked target scaffold")
  ))
})

cat("PI_R_RESULT:", toJSON(result, auto_unbox = TRUE, null = "null", na = "null", digits = NA), "\n", sep = "")
flush(stdout())
