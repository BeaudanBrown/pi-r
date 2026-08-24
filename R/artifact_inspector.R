suppressPackageStartupMessages(library(jsonlite))

`%||%` <- function(left, right) if (is.null(left)) right else left

bounded_text <- function(value, max_bytes = 2000L) {
  text <- paste(as.character(value %||% character()), collapse = "\n")
  if (nchar(text, type = "bytes") > max_bytes) substr(text, 1L, max_bytes) else text
}

error_envelope <- function(request, status, code, message, recovery, metadata_hash = NULL) {
  list(
    identity = list(target = request$target, metadataHash = metadata_hash),
    kind = request$kind,
    producer = request$producer,
    status = status,
    facets = unlist(request$facets, use.names = FALSE),
    structure = NULL,
    summaries = NULL,
    warnings = list(),
    error = list(code = code, message = bounded_text(message), recoverable = TRUE, recovery = recovery),
    cache = list(hit = FALSE, key = paste(sort(unlist(request$facets, use.names = FALSE)), collapse = ","))
  )
}

table_structure <- function(value, include_summary) {
  all_names <- names(value)
  truncated <- length(all_names) > 100L
  column_names <- head(all_names, 100L)
  columns <- lapply(column_names, function(name) list(name = substr(name, 1L, 200L), type = substr(paste(class(value[[name]]), collapse = "/"), 1L, 200L)))
  summaries <- if (!include_summary) NULL else lapply(column_names, function(name) {
    column <- value[[name]]
    common <- list(name = substr(name, 1L, 200L), type = substr(paste(class(column), collapse = "/"), 1L, 200L), missing = sum(is.na(column)))
    if (is.numeric(column)) {
      finite <- column[is.finite(column)]
      c(common, list(
        minimum = if (length(finite)) min(finite) else NULL,
        maximum = if (length(finite)) max(finite) else NULL,
        mean = if (length(finite)) mean(finite) else NULL
      ))
    } else {
      c(common, list(unique = length(unique(column))))
    }
  })
  list(
    structure = list(
      dimensions = unname(dim(value)),
      columns = columns,
      columnsTruncated = truncated,
      keys = if (requireNamespace("data.table", quietly = TRUE) && data.table::is.data.table(value)) as.list(substr(data.table::key(value) %||% character(), 1L, 200L)) else list()
    ),
    summaries = summaries
  )
}

object_structure <- function(value) {
  value_names <- names(value) %||% character()
  list(
    class = as.list(substr(class(value), 1L, 200L)),
    length = length(value),
    bytes = length(serialize(value, NULL)),
    names = as.list(substr(head(value_names, 100L), 1L, 200L)),
    namesTruncated = length(value_names) > 100L
  )
}

file_structure <- function(value) {
  paths <- as.character(value)
  truncated <- length(paths) > 100L
  paths <- head(paths, 100L)
  info <- file.info(paths)
  list(
    count = length(value),
    paths = unname(substr(paths, 1L, 1000L)),
    pathsTruncated = truncated,
    exists = unname(file.exists(paths)),
    directories = unname(!is.na(info$isdir) & info$isdir),
    bytes = unname(ifelse(is.na(info$size), NA_real_, info$size))
  )
}

inspect_artifact <- function(request) {
  target <- request$target
  metadata <- targets::tar_meta(fields = c("name", "data", "bytes", "time", "warnings", "error"), complete_only = FALSE)
  row <- metadata[metadata$name == target, , drop = FALSE]
  outdated <- tryCatch(targets::tar_outdated(callr_function = NULL), error = function(...) target)
  if (!nrow(row)) {
    return(error_envelope(request, "missing", "MISSING_TARGET", "Target has no stored artifact", c("Run r_targets_run for the target")))
  }
  metadata_hash <- if ("data" %in% names(row) && !is.na(row$data[[1L]])) as.character(row$data[[1L]]) else NULL
  target_error <- if ("error" %in% names(row) && !is.na(row$error[[1L]])) bounded_text(row$error[[1L]]) else ""
  if (nzchar(target_error)) {
    return(error_envelope(
      request,
      "failed",
      "FAILED_TARGET",
      target_error,
      c("Run r_targets_run for the target", "Load its failed workspace with r_target_workspace"),
      metadata_hash
    ))
  }
  if (target %in% outdated) {
    return(error_envelope(request, "stale", "STALE_TARGET", "Stored artifact is older than its declared inputs or command", c("Run r_targets_run for the target"), metadata_hash))
  }

  cache_key <- paste(sort(unlist(request$facets, use.names = FALSE)), collapse = ",")
  cached <- request$cached
  if (!is.null(metadata_hash) && !is.null(cached) && identical(cached$identity$metadataHash, metadata_hash) && identical(cached$cache$key, cache_key)) {
    cached$cache$hit <- TRUE
    return(cached)
  }

  value <- targets::tar_read_raw(target)
  warnings <- list()
  include_summary <- "summary" %in% unlist(request$facets, use.names = FALSE)
  inspected <- if (identical(request$kind, "table")) {
    if (!requireNamespace("data.table", quietly = TRUE) || !data.table::is.data.table(value)) {
      warnings <- list(list(
        code = "DECLARED_TABLE_NOT_DATA_TABLE",
        message = "Declared table target is not a data.table",
        recoverable = TRUE
      ))
    }
    table_structure(value, include_summary)
  } else if (identical(request$kind, "file")) {
    list(structure = file_structure(value), summaries = NULL)
  } else {
    list(structure = object_structure(value), summaries = NULL)
  }

  list(
    identity = list(target = target, metadataHash = metadata_hash),
    kind = request$kind,
    producer = request$producer,
    status = "current",
    facets = unlist(request$facets, use.names = FALSE),
    structure = inspected$structure,
    summaries = inspected$summaries,
    warnings = warnings,
    error = NULL,
    cache = list(hit = FALSE, key = cache_key)
  )
}

request_line <- readLines(file("stdin", open = "r"), n = 1L, warn = FALSE)
request <- fromJSON(request_line, simplifyVector = FALSE)
result <- tryCatch(
  inspect_artifact(request),
  error = function(condition) error_envelope(
    request,
    "failed",
    "ARTIFACT_INSPECTION_FAILED",
    conditionMessage(condition),
    c("Inspect target freshness with r_targets_list", "Run r_targets_run for the target")
  )
)
cat("PI_R_RESULT:", toJSON(result, auto_unbox = TRUE, null = "null", na = "null", digits = NA), "\n", sep = "")
flush(stdout())
