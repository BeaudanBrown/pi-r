`%||%` <- function(left, right) if (is.null(left)) right else left

pi_r_bound_string <- function(value, max_bytes = 1000L) {
  text <- paste(as.character(value %||% character()), collapse = "\n")
  if (nchar(text, type = "bytes") > max_bytes) substr(text, 1L, max_bytes) else text
}

pi_r_column_summary <- function(column, name) {
  common <- list(
    name = substr(name, 1L, 200L),
    class = as.list(substr(head(class(column), 4L), 1L, 100L)),
    missing = sum(is.na(column)),
    unique = length(unique(column))
  )
  if (is.numeric(column)) {
    finite <- column[is.finite(column)]
    return(c(common, list(
      minimum = if (length(finite)) min(finite) else NULL,
      maximum = if (length(finite)) max(finite) else NULL,
      mean = if (length(finite)) mean(finite) else NULL
    )))
  }
  counts <- sort(table(column, useNA = "ifany"), decreasing = TRUE)
  count_names <- names(head(counts, 10L))
  c(common, list(top = unname(lapply(seq_along(count_names), function(index) list(
    value = pi_r_bound_string(count_names[[index]], 200L),
    count = unname(head(counts, 10L)[[index]])
  )))))
}

pi_r_table_summary <- function(value, columns = character(), column_offset = 0L, column_limit = 20L) {
  all_names <- names(value) %||% character()
  offset <- max(0L, as.integer(column_offset %||% 0L))
  limit <- min(50L, max(1L, as.integer(column_limit %||% 20L)))
  start <- offset + 1L
  page_names <- if (start > length(all_names)) character() else head(all_names[seq.int(start, length(all_names))], limit)
  selected <- unique(as.character(columns %||% character()))
  missing_columns <- setdiff(selected, all_names)
  selected <- intersect(selected, all_names)
  list(
    kind = "table",
    class = as.list(substr(head(class(value), 8L), 1L, 100L)),
    bytes = length(serialize(value, NULL)),
    dimensions = unname(dim(value)),
    columns = list(
      total = length(all_names),
      offset = offset,
      returned = length(page_names),
      nextOffset = if (offset + length(page_names) < length(all_names)) offset + length(page_names) else NULL,
      items = unname(lapply(page_names, function(name) list(
        name = substr(name, 1L, 200L),
        class = as.list(substr(head(class(value[[name]]), 4L), 1L, 100L))
      )))
    ),
    selected = unname(lapply(selected, function(name) pi_r_column_summary(value[[name]], name))),
    missingColumns = as.list(substr(missing_columns, 1L, 200L)),
    keys = if (requireNamespace("data.table", quietly = TRUE) && data.table::is.data.table(value)) {
      as.list(substr(data.table::key(value) %||% character(), 1L, 200L))
    } else list()
  )
}

pi_r_value_summary <- function(value, depth = 0L, max_depth = 2L, max_entries = 20L,
                               columns = character(), column_offset = 0L, column_limit = 20L) {
  if (is.null(value)) return(list(kind = "null"))
  if (is.data.frame(value)) {
    return(pi_r_table_summary(value, columns, column_offset, column_limit))
  }
  classes <- as.list(substr(head(class(value), 8L), 1L, 100L))
  bytes <- length(serialize(value, NULL))
  if (is.atomic(value)) {
    shown <- head(value, max_entries)
    return(list(
      kind = "atomic",
      class = classes,
      length = length(value),
      bytes = bytes,
      values = unname(as.list(shown)),
      omitted = max(0L, length(value) - length(shown))
    ))
  }
  if (is.list(value)) {
    value_names <- names(value) %||% rep("", length(value))
    count <- min(length(value), max_entries)
    entries <- if (depth >= max_depth) list() else unname(lapply(seq_len(count), function(index) list(
      name = substr(value_names[[index]], 1L, 200L),
      summary = pi_r_value_summary(value[[index]], depth + 1L, max_depth, max_entries)
    )))
    return(list(
      kind = "list",
      class = classes,
      length = length(value),
      bytes = bytes,
      entries = entries,
      omitted = max(0L, length(value) - count),
      depthLimited = depth >= max_depth
    ))
  }
  list(kind = "object", class = classes, length = length(value), bytes = bytes)
}
