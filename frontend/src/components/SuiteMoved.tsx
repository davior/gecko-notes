/** Where account settings went, shown in place of a form that would only answer 410. */
export function ManagedInSuite({ suiteUrl, what, path }: { suiteUrl: string; what: string; path: string }) {
  return (
    <div className="card p-5 space-y-2">
      <p className="text-sm text-gray-700 dark:text-gray-300">
        Manage {what} in Gecko Suite. It is one account for every Gecko app, so a change
        there applies here too.
      </p>
      <a href={`${suiteUrl}${path}`} className="btn-primary inline-block">
        Open Gecko Suite
      </a>
    </div>
  )
}

/**
 * A Notes email link (verify, reset) opened after the suite took over. The token in it
 * was Notes' and cannot be spent anywhere now, so say where to go instead of failing on
 * a 410.
 */
export function MovedToSuite({ suiteUrl, title, path, action }: {
  suiteUrl: string
  title: string
  path: string
  action: string
}) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-950 px-4">
      <div className="card p-6 max-w-md w-full space-y-4 text-center">
        <h1 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{title}</h1>
        <p className="text-sm text-gray-600 dark:text-gray-400">
          Accounts are kept by Gecko Suite now, so this link from Gecko Notes no longer works.
        </p>
        <a href={`${suiteUrl}${path}`} className="btn-primary inline-block w-full">
          {action}
        </a>
      </div>
    </div>
  )
}
